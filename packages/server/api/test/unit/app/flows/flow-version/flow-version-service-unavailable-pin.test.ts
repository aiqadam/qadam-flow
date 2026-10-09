import { PropertyType, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    ErrorCode,
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    PackageType,
    QadamFlowError,
    QadamType,
    TriggerStrategy,
    TriggerTestStrategy,
    tryCatch,
} from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flowVersionService } from '../../../../../src/app/flows/flow-version/flow-version.service'
import { createMockFlowVersion } from '../../../../helpers/mocks'

// This file drives `flowVersionService.applyOperation` with the REAL validator, so it is what proves
// `applySingleOperation` hands the stored flow version to `prepareRequest`: the unit tests of the
// validator call it directly and would stay green if that wiring line were deleted (#843).
const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: vi.fn(() => () => ({
        findOne: vi.fn(),
        save: (flowVersion: FlowVersion) => Promise.resolve(flowVersion),
        exists: vi.fn(),
    })),
}))

vi.mock('../../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

vi.mock('../../../../../src/app/qadams/metadata/qadam-cache', () => ({
    qadamCache: () => ({
        setup: async () => undefined,
        loadRegistry: (...args: unknown[]) => loadRegistry(...args),
        invalidate: async () => undefined,
    }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version-migration.service', () => ({
    flowVersionMigrationService: vi.fn(() => ({
        migrate: vi.fn((flowVersion: FlowVersion) => Promise.resolve(flowVersion)),
    })),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version-side-effects', () => ({
    flowVersionSideEffects: vi.fn(() => ({
        preApplyOperation: vi.fn(),
    })),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({ getPlatformId: vi.fn().mockResolvedValue('platform-1') })),
}))

vi.mock('../../../../../src/app/user/user-service', () => ({
    userService: vi.fn(() => ({ getMetaInformation: vi.fn() })),
}))

vi.mock('../../../../../src/app/flows/step-run/sample-data.service', () => ({
    sampleDataService: vi.fn(() => ({ saveSampleDataFileIdsInStep: vi.fn() })),
}))


const log = pino({ level: 'silent' })

const QADAM_NAME = '@aiqadam/qadam-fixture'
// Outside `^0.5.x`, so `get()` cannot resolve it while 0.5.1 is installed.
const UNAVAILABLE_PIN = '0.3.1'
const INSTALLED_VERSION = '0.5.1'

function installedQadam() {
    const props = { subject: { type: PropertyType.SHORT_TEXT, required: true, displayName: 'subject' } }
    const parsed = QadamMetadataModel.parse({
        name: QADAM_NAME,
        displayName: QADAM_NAME,
        logoUrl: '',
        description: '',
        authors: [],
        version: INSTALLED_VERSION,
        actions: { do_thing: { name: 'do_thing', displayName: 'Do thing', description: '', requireAuth: false, props } },
        triggers: {
            on_thing: {
                name: 'on_thing',
                displayName: 'On thing',
                description: '',
                requireAuth: false,
                type: TriggerStrategy.POLLING,
                testStrategy: TriggerTestStrategy.TEST_FUNCTION,
                sampleData: {},
                props,
            },
        },
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    })
    return { ...parsed, contextInfo: undefined }
}

function flowPinnedTo({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    const trigger = FlowTrigger.parse({
        name: 'trigger',
        displayName: 'On thing',
        valid: true,
        lastUpdatedDate: '2026-10-01T00:00:00.000Z',
        type: FlowTriggerType.PIECE,
        settings: { qadamName: QADAM_NAME, qadamVersion, triggerName: 'on_thing', input: { subject: 'hello' }, propertySettings: {} },
        nextAction: {
            name: 'step_1',
            displayName: 'Do thing',
            valid: true,
            type: FlowActionType.PIECE,
            settings: { qadamName: QADAM_NAME, qadamVersion, actionName: 'do_thing', input: { subject: 'hello' }, propertySettings: {} },
        },
    })
    return createMockFlowVersion({ trigger })
}

function apply({ userOperation }: { userOperation: FlowOperationRequest }): Promise<FlowVersion> {
    return flowVersionService(log).applyOperation({
        projectId: 'proj-1',
        platformId: 'platform-1',
        userId: 'user-1',
        flowVersion: flowPinnedTo({ qadamVersion: UNAVAILABLE_PIN }),
        userOperation,
    })
}

function renameAction({ qadamVersion }: { qadamVersion: string }): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.UPDATE_ACTION,
        request: {
            type: FlowActionType.PIECE,
            name: 'step_1',
            displayName: 'Renamed',
            valid: true,
            settings: { qadamName: QADAM_NAME, qadamVersion, actionName: 'do_thing', input: { subject: 'hello' }, propertySettings: {} },
        },
    })
}

function renameTrigger({ qadamVersion }: { qadamVersion: string }): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.UPDATE_TRIGGER,
        request: {
            type: FlowTriggerType.PIECE,
            name: 'trigger',
            displayName: 'Renamed trigger',
            valid: true,
            lastUpdatedDate: '2026-10-01T00:00:00.000Z',
            settings: { qadamName: QADAM_NAME, qadamVersion, triggerName: 'on_thing', input: { subject: 'hello' }, propertySettings: {} },
        },
    })
}

function addAction({ qadamVersion }: { qadamVersion: string }): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.ADD_ACTION,
        request: {
            parentStep: 'step_1',
            stepLocationRelativeToParent: 'AFTER',
            action: {
                type: FlowActionType.PIECE,
                name: 'step_2',
                displayName: 'New step',
                valid: true,
                settings: { qadamName: QADAM_NAME, qadamVersion, actionName: 'do_thing', input: { subject: 'hello' }, propertySettings: {} },
            },
        },
    })
}

describe('flowVersionService.applyOperation — step pinned to an unavailable qadam version (#843)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([installedQadam()])
    })

    it('renames a PIECE step and keeps its pin', async () => {
        const result = await apply({ userOperation: renameAction({ qadamVersion: UNAVAILABLE_PIN }) })

        const step = result.trigger.nextAction
        expect(step?.displayName).toBe('Renamed')
        expect(step?.type === FlowActionType.PIECE && step.settings.qadamVersion).toBe(UNAVAILABLE_PIN)
    })

    it('renames the PIECE trigger and keeps its pin', async () => {
        const result = await apply({ userOperation: renameTrigger({ qadamVersion: UNAVAILABLE_PIN }) })

        expect(result.trigger.displayName).toBe('Renamed trigger')
        expect(result.trigger.type === FlowTriggerType.PIECE && result.trigger.settings.qadamVersion).toBe(UNAVAILABLE_PIN)
    })

    it('still refuses an ADD_ACTION that carries the same unavailable pin', async () => {
        const { error } = await tryCatch(() => apply({ userOperation: addAction({ qadamVersion: UNAVAILABLE_PIN }) }))

        expect(error).toBeInstanceOf(QadamFlowError)
        expect(error instanceof QadamFlowError && error.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
    })

    it('still refuses an UPDATE_ACTION that repoints the step to another version nothing resolves', async () => {
        const { error } = await tryCatch(() => apply({ userOperation: renameAction({ qadamVersion: '9.9.9' }) }))

        expect(error instanceof QadamFlowError && error.error.code).toBe(ErrorCode.ENTITY_NOT_FOUND)
    })
})

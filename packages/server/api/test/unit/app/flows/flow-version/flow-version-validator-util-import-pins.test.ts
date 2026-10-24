import { PropertyType, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
    FlowTriggerType,
    PackageType,
    QadamType,
    TriggerStrategy,
    TriggerTestStrategy,
} from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()

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

import { flowVersionValidationUtil } from '../../../../../src/app/flows/flow-version/flow-version-validator-util'

const log = pino({ level: 'silent' })

const QADAM_NAME = '@aiqadam/qadam-fixture'
const INSTALLED_VERSION = '0.5.1'
const PLATFORM_ID = 'platform-1'

function installedQadam({ version }: { version: string }) {
    const parsed = QadamMetadataModel.parse({
        name: QADAM_NAME,
        displayName: QADAM_NAME,
        logoUrl: '',
        description: '',
        authors: [],
        version,
        actions: {
            do_thing: {
                name: 'do_thing',
                displayName: 'Do thing',
                description: '',
                requireAuth: false,
                props: {
                    subject: { type: PropertyType.SHORT_TEXT, required: true, displayName: 'subject' },
                },
            },
        },
        triggers: {
            on_thing: {
                name: 'on_thing',
                displayName: 'On thing',
                description: '',
                requireAuth: false,
                type: TriggerStrategy.POLLING,
                testStrategy: TriggerTestStrategy.TEST_FUNCTION,
                sampleData: {},
                props: {
                    subject: { type: PropertyType.SHORT_TEXT, required: true, displayName: 'subject' },
                },
            },
        },
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    })
    return { ...parsed, contextInfo: undefined }
}

function importFlowRequest({ triggerVersion, actionVersion, triggerInput, actionInput, triggerValid = true, actionValid = true }: {
    triggerVersion: string
    actionVersion: string
    triggerInput?: Record<string, unknown>
    actionInput?: Record<string, unknown>
    triggerValid?: boolean
    actionValid?: boolean
}): FlowOperationRequest {
    return FlowOperationRequest.parse({
        type: FlowOperationType.IMPORT_FLOW,
        request: {
            displayName: 'Imported flow',
            schemaVersion: null,
            trigger: {
                name: 'trigger',
                displayName: 'On thing',
                // The importer's own `valid` flag is untrusted: it is whatever the export file or
                // the caller supplied, not something `prepareRequest` has checked yet.
                valid: triggerValid,
                lastUpdatedDate: '2026-10-01T00:00:00.000Z',
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: QADAM_NAME,
                    qadamVersion: triggerVersion,
                    triggerName: 'on_thing',
                    input: triggerInput ?? { subject: 'hello' },
                    propertySettings: {},
                },
                nextAction: {
                    name: 'step_1',
                    displayName: 'Do thing',
                    valid: actionValid,
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: QADAM_NAME,
                        qadamVersion: actionVersion,
                        actionName: 'do_thing',
                        input: actionInput ?? { subject: 'hello' },
                        propertySettings: {},
                    },
                },
            },
        },
    })
}

async function prepare(request: FlowOperationRequest): Promise<FlowOperationRequest> {
    return flowVersionValidationUtil(log).prepareRequest({
        platformId: PLATFORM_ID,
        userId: null,
        request,
    })
}

function readImportedTrigger(prepared: FlowOperationRequest): { valid: boolean, qadamVersion: string, input: Record<string, unknown> } {
    if (prepared.type !== FlowOperationType.IMPORT_FLOW || prepared.request.trigger.type !== FlowTriggerType.PIECE) {
        throw new Error('expected a PIECE trigger on an IMPORT_FLOW request')
    }
    const { valid, settings } = prepared.request.trigger
    return { valid, qadamVersion: settings.qadamVersion, input: settings.input }
}

function readImportedAction(prepared: FlowOperationRequest): { valid: boolean, qadamVersion: string } {
    if (prepared.type !== FlowOperationType.IMPORT_FLOW) {
        throw new Error('expected an IMPORT_FLOW request')
    }
    const action = prepared.request.trigger.nextAction
    if (action?.type !== FlowActionType.PIECE) {
        throw new Error('expected a PIECE action on an IMPORT_FLOW request')
    }
    return { valid: action.valid, qadamVersion: action.settings.qadamVersion }
}

describe('flowVersionValidationUtil.prepareRequest — IMPORT_FLOW pin normalisation and resolvability (#782)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([installedQadam({ version: INSTALLED_VERSION })])
    })

    it('strips a caret/tilde range from both the trigger\'s and an action\'s pin, the same as ADD_ACTION/UPDATE_TRIGGER do', async () => {
        const prepared = await prepare(importFlowRequest({ triggerVersion: `~${INSTALLED_VERSION}`, actionVersion: `^${INSTALLED_VERSION}` }))

        expect(readImportedTrigger(prepared).qadamVersion).toBe(INSTALLED_VERSION)
        expect(readImportedAction(prepared).qadamVersion).toBe(INSTALLED_VERSION)
    })

    it('recomputes validity against the installed qadam rather than trusting the caller\'s valid flag', async () => {
        const prepared = await prepare(importFlowRequest({
            triggerVersion: INSTALLED_VERSION,
            actionVersion: INSTALLED_VERSION,
            triggerInput: { subject: 'hello' },
            actionInput: { somethingElse: 'x' },
            triggerValid: true,
            actionValid: true,
        }))

        // The trigger's input satisfies the installed qadam's required prop; the action's does not —
        // despite the import payload claiming both are valid.
        expect(readImportedTrigger(prepared).valid).toBe(true)
        expect(readImportedAction(prepared).valid).toBe(false)
    })

    it('keeps the caller\'s reported validity, rather than throwing or forcing invalid, when this instance cannot resolve the pin', async () => {
        // Unlike ADD_ACTION/UPDATE_TRIGGER, IMPORT_FLOW must neither throw on an unresolvable pin
        // nor force the step invalid. It is also how a published flow's own stored version is
        // re-imported on every edit (`createNewDraftIfVersionIsPublished`), and ADR-0003 is explicit
        // that an unavailable version is advisory ("marked 'update this step'... the flow is never
        // disabled") — forcing `valid: false` here would route that same case through the unrelated
        // `!step.valid` publish gate and block it anyway, just by a different door
        // (`flow-unavailable-qadam-pin.test.ts`, #808).
        const prepared = await prepare(importFlowRequest({
            triggerVersion: '9.9.9',
            actionVersion: INSTALLED_VERSION,
            triggerInput: { subject: 'untouched' },
            triggerValid: true,
            actionValid: true,
        }))

        expect(readImportedTrigger(prepared).valid).toBe(true)
        expect(readImportedTrigger(prepared).input).toEqual({ subject: 'untouched' })
        expect(readImportedAction(prepared).valid).toBe(true)
    })

    it('does not mark a well-formed, resolvable step valid just because the caller said so — it is independently true', async () => {
        const prepared = await prepare(importFlowRequest({
            triggerVersion: INSTALLED_VERSION,
            actionVersion: INSTALLED_VERSION,
            triggerValid: false,
            actionValid: false,
        }))

        expect(readImportedTrigger(prepared).valid).toBe(true)
        expect(readImportedAction(prepared).valid).toBe(true)
    })
})

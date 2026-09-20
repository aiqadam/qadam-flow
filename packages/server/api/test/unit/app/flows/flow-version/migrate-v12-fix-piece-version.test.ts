import { FlowActionType, FlowVersion } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOrThrow = vi.fn()
const mockGetOneById = vi.fn()
const mockGetPlatformId = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { getOrThrow: typeof mockGetOrThrow } => ({ getOrThrow: mockGetOrThrow }),
}))

vi.mock('../../../../../src/app/flows/flow/flow.service', () => ({
    flowService: (): { getOneById: typeof mockGetOneById } => ({ getOneById: mockGetOneById }),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: (): { getPlatformId: typeof mockGetPlatformId } => ({ getPlatformId: mockGetPlatformId }),
}))

import { migrateV12FixPieceVersion } from '../../../../../src/app/flows/flow-version/migrations/migrate-v12-fix-piece-version'

const FIXABLE_QADAM_NAME = '@aiqadam/qadam-widgets'
const FIXABLE_OLD_VERSION = '0.3.1'
const FIXABLE_RESOLVED_VERSION = '0.4.5'
const PROTOTYPE_NAMED_QADAM_NAME = '@aiqadam/qadam-slack'
const PROTOTYPE_NAMED_STEP_VERSION = '0.2.0'
const PLATFORM_ID = 'platform-1'

// A step whose pinned version the metadata lookup will correct on `step_1`, plus a second,
// perfectly healthy step literally named `constructor` whose own lookup fails (mirroring a qadam
// that is not registered under that exact version) — `STEP_NAME_REGEX`
// (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) admits `constructor`, and it survives `ap_import_flow` verbatim.
// `transferFlow` invokes its callback for every step, not only the corrected one, so a bare
// `Record` index for the replacement lookup would reach `Object.prototype` for this step and hand
// back the `Object` constructor as its "piece version" — with no entry ever written for it.
function lockedFlowVersionWithFixableStepAndPrototypeNamedStep(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'prototype pollution guard flow',
        valid: true,
        schemaVersion: '12',
        state: 'LOCKED',
        trigger: {
            name: 'trigger',
            type: 'EMPTY',
            valid: true,
            displayName: 'Select Trigger',
            settings: {},
            nextAction: {
                name: 'step_1',
                type: FlowActionType.PIECE,
                valid: true,
                displayName: 'Fixable Step',
                settings: {
                    qadamName: FIXABLE_QADAM_NAME,
                    qadamVersion: FIXABLE_OLD_VERSION,
                    actionName: 'doThing',
                    input: {},
                    inputUiInfo: {},
                },
                nextAction: {
                    name: 'constructor',
                    type: FlowActionType.PIECE,
                    valid: true,
                    displayName: 'Prototype-Named Step',
                    settings: {
                        qadamName: PROTOTYPE_NAMED_QADAM_NAME,
                        qadamVersion: PROTOTYPE_NAMED_STEP_VERSION,
                        actionName: 'send_channel_message',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readPins(version: FlowVersion): { fixedStep: string, prototypeNamedStepName: string, prototypeNamedStepVersion: unknown } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { name: string, settings: { qadamVersion: unknown } } }
    }
    return {
        fixedStep: chain.nextAction.settings.qadamVersion,
        prototypeNamedStepName: chain.nextAction.nextAction.name,
        prototypeNamedStepVersion: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

describe('migrateV12FixPieceVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneById.mockResolvedValue({ id: 'flow-1', projectId: 'project-1' })
        mockGetPlatformId.mockResolvedValue(PLATFORM_ID)
        mockGetOrThrow.mockImplementation(async ({ name, version }: { name: string, version: string }) => {
            if (name === FIXABLE_QADAM_NAME && version === FIXABLE_OLD_VERSION) {
                return { name, version: FIXABLE_RESOLVED_VERSION }
            }
            throw new Error('qadam_metadata_not_found')
        })
    })

    it('starts at 12', () => {
        expect(migrateV12FixPieceVersion.targetSchemaVersion).toBe('12')
    })

    it('does nothing to a flow version that is not LOCKED', async () => {
        const version = lockedFlowVersionWithFixableStepAndPrototypeNamedStep()
        version.state = 'DRAFT' as FlowVersion['state']

        const migrated = await migrateV12FixPieceVersion.migrate(version)

        expect(readPins(migrated).fixedStep).toBe(FIXABLE_OLD_VERSION)
        expect(migrated.schemaVersion).toBe('13')
        expect(mockGetOneById).not.toHaveBeenCalled()
    })

    it('rewrites a LOCKED step to the version the qadam metadata service resolves', async () => {
        const migrated = await migrateV12FixPieceVersion.migrate(lockedFlowVersionWithFixableStepAndPrototypeNamedStep())

        expect(readPins(migrated).fixedStep).toBe(FIXABLE_RESOLVED_VERSION)
        expect(migrated.schemaVersion).toBe('13')
    })

    // Blocking finding: a bare `Record` index hits `Object.prototype` for a step literally named
    // `constructor`, even though the write loop never inserted an entry for it (its own metadata
    // lookup fails and is swallowed by `tryCatch`). This must fail on a `Record`-based
    // implementation (the "piece version" for the prototype-named step resolves to the `Object`
    // constructor function, not `undefined`, so the truthiness check lets it through) and pass
    // with a `Map`.
    it('does not corrupt a step literally named "constructor" while fixing another step in the same flow version', async () => {
        const migrated = await migrateV12FixPieceVersion.migrate(lockedFlowVersionWithFixableStepAndPrototypeNamedStep())

        const pins = readPins(migrated)
        expect(pins.prototypeNamedStepName).toBe('constructor')
        expect(pins.prototypeNamedStepVersion).toBe(PROTOTYPE_NAMED_STEP_VERSION)
        expect(typeof pins.prototypeNamedStepVersion).toBe('string')
    })
})

import { FlowActionType, FlowVersion } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockGetOneById = vi.fn()
const mockGetPlatformId = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { get: typeof mockGet } => ({ get: mockGet }),
}))

vi.mock('../../../../../src/app/flows/flow/flow.service', () => ({
    flowService: (): { getOneById: typeof mockGetOneById } => ({ getOneById: mockGetOneById }),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: (): { getPlatformId: typeof mockGetPlatformId } => ({ getPlatformId: mockGetPlatformId }),
}))

import { migrateV19StripPieceVersionWildcards } from '../../../../../src/app/flows/flow-version/migrations/migrate-v19-strip-piece-version-wildcards'

const WILDCARD_QADAM_NAME = '@aiqadam/qadam-widgets'
const WILDCARD_VERSION = '^0.3.1'
const RESOLVED_VERSION = '0.3.9'
const PROTOTYPE_NAMED_QADAM_NAME = '@aiqadam/qadam-slack'
const PROTOTYPE_NAMED_STEP_EXACT_VERSION = '0.2.0'
const PLATFORM_ID = 'platform-1'

// A wildcard-pinned step on `step_1`, plus a second, perfectly healthy step literally named
// `constructor` — `STEP_NAME_REGEX` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) admits it, and it survives
// `ap_import_flow` verbatim. `transferFlow` invokes its callback for every step, not only the
// rewritten one, so a bare `Record` index for the exact-version lookup would reach
// `Object.prototype` for this step and hand back the `Object` constructor as its "exact version".
function flowVersionWithWildcardStepAndPrototypeNamedStep(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'prototype pollution guard flow',
        valid: true,
        schemaVersion: '19',
        state: 'DRAFT',
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
                displayName: 'Wildcard Step',
                settings: {
                    qadamName: WILDCARD_QADAM_NAME,
                    qadamVersion: WILDCARD_VERSION,
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
                        qadamVersion: PROTOTYPE_NAMED_STEP_EXACT_VERSION,
                        actionName: 'send_channel_message',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readPins(version: FlowVersion): { wildcardStep: string, prototypeNamedStepName: string, prototypeNamedStepVersion: unknown } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { name: string, settings: { qadamVersion: unknown } } }
    }
    return {
        wildcardStep: chain.nextAction.settings.qadamVersion,
        prototypeNamedStepName: chain.nextAction.nextAction.name,
        prototypeNamedStepVersion: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

describe('migrateV19StripPieceVersionWildcards', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneById.mockResolvedValue({ id: 'flow-1', projectId: 'project-1' })
        mockGetPlatformId.mockResolvedValue(PLATFORM_ID)
        mockGet.mockImplementation(async ({ name, version }: { name: string, version: string }) => {
            if (name === WILDCARD_QADAM_NAME && version === RESOLVED_VERSION) {
                return { name, version }
            }
            return undefined
        })
    })

    it('starts at 19', () => {
        expect(migrateV19StripPieceVersionWildcards.targetSchemaVersion).toBe('19')
    })

    it('strips the wildcard prefix from a pinned step, resolving to the exact version the registry currently serves', async () => {
        mockGet.mockResolvedValue({ name: WILDCARD_QADAM_NAME, version: RESOLVED_VERSION })

        const migrated = await migrateV19StripPieceVersionWildcards.migrate(flowVersionWithWildcardStepAndPrototypeNamedStep())

        expect(readPins(migrated).wildcardStep).toBe(RESOLVED_VERSION)
        expect(migrated.schemaVersion).toBe('20')
    })

    // Blocking finding: a bare `Record` index hits `Object.prototype` for a step literally named
    // `constructor`. This must fail on a `Record`-based implementation (the "exact version" for the
    // prototype-named step resolves to the `Object` constructor function, not `undefined`, so
    // `isNil` lets it through and `qadamVersion` gets overwritten with it) and pass with a `Map`.
    it('does not corrupt a step literally named "constructor" while stripping a wildcard from another step in the same flow version', async () => {
        const migrated = await migrateV19StripPieceVersionWildcards.migrate(flowVersionWithWildcardStepAndPrototypeNamedStep())

        const pins = readPins(migrated)
        expect(pins.prototypeNamedStepName).toBe('constructor')
        expect(pins.prototypeNamedStepVersion).toBe(PROTOTYPE_NAMED_STEP_EXACT_VERSION)
        expect(typeof pins.prototypeNamedStepVersion).toBe('string')
    })

    it('leaves an already-exact version untouched', async () => {
        const migrated = await migrateV19StripPieceVersionWildcards.migrate(flowVersionWithWildcardStepAndPrototypeNamedStep())

        expect(readPins(migrated).prototypeNamedStepVersion).toBe(PROTOTYPE_NAMED_STEP_EXACT_VERSION)
        expect(mockGet).toHaveBeenCalledTimes(1)
    })

    it('falls back to stripping the wildcard prefix locally when the registry has nothing for that exact version', async () => {
        mockGet.mockResolvedValue(undefined)

        const migrated = await migrateV19StripPieceVersionWildcards.migrate(flowVersionWithWildcardStepAndPrototypeNamedStep())

        expect(readPins(migrated).wildcardStep).toBe('0.3.1')
        expect(migrated.schemaVersion).toBe('20')
    })
})

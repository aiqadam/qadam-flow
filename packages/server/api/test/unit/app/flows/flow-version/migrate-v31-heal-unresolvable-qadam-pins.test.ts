import { FlowActionType, FlowVersion, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockRegistry = vi.fn()
const mockGetOneById = vi.fn()
const mockGetPlatformId = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { get: typeof mockGet, registry: typeof mockRegistry } => ({ get: mockGet, registry: mockRegistry }),
}))

vi.mock('../../../../../src/app/flows/flow/flow.service', () => ({
    flowService: (): { getOneById: typeof mockGetOneById } => ({ getOneById: mockGetOneById }),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: (): { getPlatformId: typeof mockGetPlatformId } => ({ getPlatformId: mockGetPlatformId }),
}))

import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { migrateV31HealUnresolvableQadamPins } from '../../../../../src/app/flows/flow-version/migrations/migrate-v31-heal-unresolvable-qadam-pins'

// A generic, made-up qadam name — the whole point of #474 step 0 is that this migration works for
// any qadam an image upgrade drops a pin for, not a hand-maintained list like v24..v30's.
const BROKEN_QADAM_NAME = '@aiqadam/qadam-widgets'
const BROKEN_OLD_VERSION = '0.3.1'
const BROKEN_REPLACEMENT_VERSION = '0.4.5'
const HEALTHY_QADAM_NAME = '@aiqadam/qadam-slack'
const HEALTHY_VERSION = '0.2.0'
const PLATFORM_ID = 'platform-1'

function flowVersionWithSteps({ schemaVersion, brokenVersion = BROKEN_OLD_VERSION }: { schemaVersion: string, brokenVersion?: string }): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'heal pins flow',
        valid: true,
        schemaVersion,
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
                displayName: 'Broken Step',
                settings: {
                    qadamName: BROKEN_QADAM_NAME,
                    qadamVersion: brokenVersion,
                    actionName: 'doThing',
                    input: {},
                    inputUiInfo: {},
                },
                nextAction: {
                    name: 'step_2',
                    type: FlowActionType.PIECE,
                    valid: true,
                    displayName: 'Healthy Step',
                    settings: {
                        qadamName: HEALTHY_QADAM_NAME,
                        qadamVersion: HEALTHY_VERSION,
                        actionName: 'send_channel_message',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readPins(version: FlowVersion): { broken: string, healthy: string } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { settings: { qadamVersion: string } } }
    }
    return {
        broken: chain.nextAction.settings.qadamVersion,
        healthy: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

// Two independently-dead qadam names in the same flow version — one the registry can replace, one
// it cannot — to prove a name with no replacement never borrows another name's fix and does not
// stop the one that does have a replacement from being healed.
function flowVersionWithTwoBrokenQadams({ replaceableVersion, unreplaceableName, unreplaceableVersion }: {
    replaceableVersion: string
    unreplaceableName: string
    unreplaceableVersion: string
}): FlowVersion {
    return {
        id: 'fv-2',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'two broken qadams flow',
        valid: true,
        schemaVersion: '31',
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
                displayName: 'Broken With Replacement',
                settings: {
                    qadamName: BROKEN_QADAM_NAME,
                    qadamVersion: replaceableVersion,
                    actionName: 'doThing',
                    input: {},
                    inputUiInfo: {},
                },
                nextAction: {
                    name: 'step_2',
                    type: FlowActionType.PIECE,
                    valid: true,
                    displayName: 'Broken Without Replacement',
                    settings: {
                        qadamName: unreplaceableName,
                        qadamVersion: unreplaceableVersion,
                        actionName: 'doOtherThing',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readTwoBrokenPins(version: FlowVersion): { replaceable: string, unreplaceable: string } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { settings: { qadamVersion: string } } }
    }
    return {
        replaceable: chain.nextAction.settings.qadamVersion,
        unreplaceable: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

// A healable broken pin on `step_1`, plus a second, perfectly healthy step literally named
// `constructor` — `STEP_NAME_REGEX` (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) admits it, and it survives
// `ap_import_flow` verbatim. `transferFlow` invokes its callback for every step, not only the
// healed one, so a bare `Record` index for the replacement lookup would reach `Object.prototype`
// for this step and hand back the `Object` constructor as its "replacement" version.
function flowVersionWithHealableBrokenPinAndPrototypeNamedStep(): FlowVersion {
    return {
        id: 'fv-3',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'prototype pollution guard flow',
        valid: true,
        schemaVersion: '31',
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
                displayName: 'Broken Step',
                settings: {
                    qadamName: BROKEN_QADAM_NAME,
                    qadamVersion: BROKEN_OLD_VERSION,
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
                        qadamName: HEALTHY_QADAM_NAME,
                        qadamVersion: HEALTHY_VERSION,
                        actionName: 'send_channel_message',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readPrototypeNamedStepPins(version: FlowVersion): { healed: string, prototypeNamedStepName: string, prototypeNamedStepVersion: unknown } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { name: string, settings: { qadamVersion: unknown } } }
    }
    return {
        healed: chain.nextAction.settings.qadamVersion,
        prototypeNamedStepName: chain.nextAction.nextAction.name,
        prototypeNamedStepVersion: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

describe('migrateV31HealUnresolvableQadamPins', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneById.mockResolvedValue({ id: 'flow-1', projectId: 'project-1' })
        mockGetPlatformId.mockResolvedValue(PLATFORM_ID)
        // Only the healthy pin and the post-heal replacement resolve; the broken pin never does.
        mockGet.mockImplementation(async ({ name, version }: { name: string, version: string }) => {
            if (name === HEALTHY_QADAM_NAME && version === HEALTHY_VERSION) {
                return { name, version }
            }
            if (name === BROKEN_QADAM_NAME && version === BROKEN_REPLACEMENT_VERSION) {
                return { name, version }
            }
            return undefined
        })
        mockRegistry.mockResolvedValue([
            { name: BROKEN_QADAM_NAME, version: BROKEN_REPLACEMENT_VERSION },
            { name: HEALTHY_QADAM_NAME, version: HEALTHY_VERSION },
        ])
    })

    it('starts at 31', () => {
        expect(migrateV31HealUnresolvableQadamPins.targetSchemaVersion).toBe('31')
    })

    it('rewrites a pin the installation can no longer resolve to whatever version the registry currently serves for that qadam', async () => {
        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_REPLACEMENT_VERSION)
        expect(migrated.schemaVersion).toBe('32')
    })

    it('leaves a resolvable pin untouched, byte for byte', async () => {
        const original = flowVersionWithSteps({ schemaVersion: '31' })

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(original)

        const originalChain = original.trigger as unknown as { nextAction: { nextAction: unknown } }
        const migratedChain = migrated.trigger as unknown as { nextAction: { nextAction: unknown } }
        expect(migratedChain.nextAction.nextAction).toEqual(originalChain.nextAction.nextAction)
        expect(readPins(migrated).healthy).toBe(HEALTHY_VERSION)
    })

    it('degrades without throwing when the flow does not exist (the template-import path, which carries no context)', async () => {
        mockGetOneById.mockResolvedValue(null)

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_OLD_VERSION)
        expect(migrated.schemaVersion).toBe('32')
        expect(mockRegistry).not.toHaveBeenCalled()
    })

    it('degrades without throwing when the platform cannot be resolved', async () => {
        mockGetPlatformId.mockRejectedValue(new Error('Platform ID for project project-1 is undefined in webhook.'))

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_OLD_VERSION)
        expect(migrated.schemaVersion).toBe('32')
    })

    it('degrades without throwing when the registry has no resolvable version for an unknown qadam name', async () => {
        mockRegistry.mockResolvedValue([{ name: HEALTHY_QADAM_NAME, version: HEALTHY_VERSION }])

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_OLD_VERSION)
        expect(migrated.schemaVersion).toBe('32')
    })

    // Blocking finding: `fetchRegistryFromDB` runs no `ORDER BY` and `registry()` never dedupes, so
    // picking the first match rather than the highest would return whatever order Postgres happens
    // to hand back — in practice the oldest. This must fail on the pre-fix `.find()` and pass after.
    it('picks the highest available version when the registry lists several for the same qadam, not just the first entry', async () => {
        mockRegistry.mockResolvedValue([
            { name: BROKEN_QADAM_NAME, version: '0.1.0' },
            { name: BROKEN_QADAM_NAME, version: BROKEN_REPLACEMENT_VERSION },
            { name: BROKEN_QADAM_NAME, version: '0.2.0' },
            { name: HEALTHY_QADAM_NAME, version: HEALTHY_VERSION },
        ])

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_REPLACEMENT_VERSION)
    })

    // Blocking finding: `tryCatch` collapses "genuinely missing" and "the lookup errored" into the
    // same `data: null`, and this migration persists its rewrite — a transient error must never be
    // read as "definitely dead", or a healthy LOCKED flow gets its pin silently changed during
    // exactly the DB-pressure window (an image upgrade) this migration is most likely to run in.
    it('leaves a pin untouched when its resolution lookup throws, rather than treating a transient error as a definite miss', async () => {
        mockGet.mockImplementation(async ({ name, version }: { name: string, version: string }) => {
            if (name === HEALTHY_QADAM_NAME && version === HEALTHY_VERSION) {
                return { name, version }
            }
            if (name === BROKEN_QADAM_NAME && version === BROKEN_OLD_VERSION) {
                throw new Error('ECONNRESET')
            }
            return undefined
        })

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(readPins(migrated).broken).toBe(BROKEN_OLD_VERSION)
        expect(migrated.schemaVersion).toBe('32')
        expect(mockRegistry).not.toHaveBeenCalled()
    })

    it('heals the dead pin that has a registry replacement while leaving a dead pin with none untouched, in the same flow version', async () => {
        const UNREPLACEABLE_NAME = '@aiqadam/qadam-unreplaceable'
        const UNREPLACEABLE_VERSION = '0.9.9'
        mockGet.mockImplementation(async ({ name, version }: { name: string, version: string }) => {
            if (name === BROKEN_QADAM_NAME && version === BROKEN_REPLACEMENT_VERSION) {
                return { name, version }
            }
            return undefined
        })
        mockRegistry.mockResolvedValue([{ name: BROKEN_QADAM_NAME, version: BROKEN_REPLACEMENT_VERSION }])

        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithTwoBrokenQadams({
            replaceableVersion: BROKEN_OLD_VERSION,
            unreplaceableName: UNREPLACEABLE_NAME,
            unreplaceableVersion: UNREPLACEABLE_VERSION,
        }))

        const pins = readTwoBrokenPins(migrated)
        expect(pins.replaceable).toBe(BROKEN_REPLACEMENT_VERSION)
        expect(pins.unreplaceable).toBe(UNREPLACEABLE_VERSION)
    })

    // Blocking finding: a bare `Record` index hits `Object.prototype` for a step literally named
    // `constructor`. This must fail on a `Record`-based implementation (the "replacement" for the
    // prototype-named step resolves to the `Object` constructor function, not `undefined`, so
    // `isNil` lets it through and `qadamVersion` gets set to it) and pass with a `Map`.
    it('does not corrupt a step literally named "constructor" while healing another step in the same flow version', async () => {
        const migrated = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithHealableBrokenPinAndPrototypeNamedStep())

        const pins = readPrototypeNamedStepPins(migrated)
        expect(pins.healed).toBe(BROKEN_REPLACEMENT_VERSION)
        expect(pins.prototypeNamedStepName).toBe('constructor')
        expect(pins.prototypeNamedStepVersion).toBe(HEALTHY_VERSION)
        expect(typeof pins.prototypeNamedStepVersion).toBe('string')
    })

    it('changes nothing on a second pass, once the pin resolves', async () => {
        const once = await migrateV31HealUnresolvableQadamPins.migrate(flowVersionWithSteps({ schemaVersion: '31' }))

        const twice = await migrateV31HealUnresolvableQadamPins.migrate({ ...once, schemaVersion: '31' })

        expect(twice.trigger).toEqual(once.trigger)
        expect(twice.schemaVersion).toBe(once.schemaVersion)
    })

    it('is reachable from the chain and lands on the latest schema version with the pin healed', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '31' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).broken).toBe(BROKEN_REPLACEMENT_VERSION)
    })
})

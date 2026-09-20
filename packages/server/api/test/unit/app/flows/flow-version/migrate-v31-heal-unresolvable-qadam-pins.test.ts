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

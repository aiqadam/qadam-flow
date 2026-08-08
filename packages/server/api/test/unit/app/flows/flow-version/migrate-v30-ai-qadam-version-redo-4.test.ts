import { FlowActionType, FlowTriggerType, FlowVersion, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRegistry = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { registry: typeof mockRegistry } => ({ registry: mockRegistry }),
}))

import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { AI_QADAM_NAME } from '../../../../../src/app/flows/flow-version/migrations/migrate-v24-ai-qadam-version'
import { migrateV30AiQadamVersionRedo4 } from '../../../../../src/app/flows/flow-version/migrations/migrate-v30-ai-qadam-version-redo-4'

// `@aiqadam/qadam-ai` is republished a fifth time (#284/#323) — `ai-sdk.ts` now rejects a stored
// `resourceName`/`region` pair that could move the AI SDK host, closing a host-validation gap. The
// bundled registry holds exactly one version per qadam name, so every step still pinned at the
// previous version resolves to nothing and `flow-version-validator-util` throws
// `qadam_metadata_not_found`. v29 cannot carry these: every flow it touched is stamped '30' and can
// never re-enter a migration targeting '29'.
const PUBLISHED_VERSION = '0.4.8'

function flowVersionWithSteps({ schemaVersion, aiQadamVersion, aiStepType = FlowActionType.PIECE }: { schemaVersion: string, aiQadamVersion: string, aiStepType?: string }): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'ask ai flow',
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
                type: aiStepType,
                valid: true,
                displayName: 'Ask AI',
                settings: {
                    qadamName: AI_QADAM_NAME,
                    qadamVersion: aiQadamVersion,
                    actionName: 'askAi',
                    input: { provider: 'custom', model: 'llama-3' },
                    inputUiInfo: {},
                },
                nextAction: {
                    name: 'step_2',
                    type: FlowActionType.PIECE,
                    valid: true,
                    displayName: 'Send Message',
                    settings: {
                        qadamName: '@aiqadam/qadam-slack',
                        qadamVersion: '0.2.0',
                        actionName: 'send_channel_message',
                        input: {},
                        inputUiInfo: {},
                    },
                },
            },
        },
    } as unknown as FlowVersion
}

function readPins(version: FlowVersion): { ai: string, slack: string } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string }, nextAction: { settings: { qadamVersion: string } } }
    }
    return {
        ai: chain.nextAction.settings.qadamVersion,
        slack: chain.nextAction.nextAction.settings.qadamVersion,
    }
}

function readAiInput(version: FlowVersion): Record<string, unknown> {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { input: Record<string, unknown> } }
    }
    return chain.nextAction.settings.input
}

describe('migrateV30AiQadamVersionRedo4', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockRegistry.mockResolvedValue([
            { name: '@aiqadam/qadam-slack', version: '0.9.0' },
            { name: AI_QADAM_NAME, version: PUBLISHED_VERSION },
        ])
    })

    it('carries an AI qadam step forward to the republished version', async () => {
        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
        expect(migrated.schemaVersion).toBe('31')
    })

    // v29 is the one that must not be edited, and this is why: a flow stamped '30' by it can only be
    // rescued by a migration that starts there.
    it('starts where v29 left off', () => {
        expect(migrateV30AiQadamVersionRedo4.targetSchemaVersion).toBe('30')
    })

    it('pins whatever version the live registry currently holds, not a number of its own', async () => {
        mockRegistry.mockResolvedValue([{ name: AI_QADAM_NAME, version: '1.2.3' }])

        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(readPins(migrated).ai).toBe('1.2.3')
    })

    it('leaves the pin alone when the registry holds no AI qadam entry', async () => {
        mockRegistry.mockResolvedValue([{ name: '@aiqadam/qadam-slack', version: '0.9.0' }])

        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(readPins(migrated).ai).toBe('0.4.7')
        expect(migrated.schemaVersion).toBe('31')
    })

    it('leaves every other qadam pin alone', async () => {
        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(readPins(migrated).slack).toBe('0.2.0')
    })

    it('rewrites a pin far older than the version before the republish', async () => {
        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.1.0' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
    })

    it('rewrites nothing on a step that is not a qadam action', async () => {
        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({
            schemaVersion: '30',
            aiQadamVersion: '0.4.7',
            aiStepType: FlowTriggerType.PIECE,
        }))

        expect(readPins(migrated).ai).toBe('0.4.7')
    })

    // No new prop and no altered input shape — this is a behaviour fix inside the qadam, not a
    // step-input change, so nothing about a stored step's input should be rewritten.
    it('writes no provider reference into a step it repins', async () => {
        const migrated = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(readAiInput(migrated)).toEqual({ provider: 'custom', model: 'llama-3' })
    })

    it('changes nothing on a second pass', async () => {
        const once = await migrateV30AiQadamVersionRedo4.migrate(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))
        const twice = await migrateV30AiQadamVersionRedo4.migrate({ ...once, schemaVersion: '30' })

        expect(twice.trigger).toEqual(once.trigger)
        expect(twice.schemaVersion).toBe(once.schemaVersion)
    })

    it('is reachable from the chain, so a version at 24 lands on the latest with its pin rewritten', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).ai).toBe(PUBLISHED_VERSION)
    })

    it('is reachable from the chain for a version stamped 30 by v29', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '30', aiQadamVersion: '0.4.7' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).ai).toBe(PUBLISHED_VERSION)
    })
})

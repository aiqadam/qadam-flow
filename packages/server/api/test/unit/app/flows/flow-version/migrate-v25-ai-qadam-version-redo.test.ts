import { FlowActionType, FlowTriggerType, FlowVersion, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRegistry = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { registry: typeof mockRegistry } => ({ registry: mockRegistry }),
}))

import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { AI_QADAM_NAME } from '../../../../../src/app/flows/flow-version/migrations/migrate-v24-ai-qadam-version'
import { migrateV25AiQadamVersionRedo } from '../../../../../src/app/flows/flow-version/migrations/migrate-v25-ai-qadam-version-redo'

// `@aiqadam/qadam-ai` is republished a second time — the five community AI actions gained an
// optional `providerId`. The bundled registry holds exactly one version per qadam name, so every
// step still pinned at the previous version resolves to nothing and `flow-version-validator-util`
// throws `qadam_metadata_not_found`. v24 cannot carry these: every flow it touched is stamped '25'
// and can never re-enter a migration targeting '24'.
const PUBLISHED_VERSION = '0.4.5'

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

describe('migrateV25AiQadamVersionRedo', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockRegistry.mockResolvedValue([
            { name: '@aiqadam/qadam-slack', version: '0.9.0' },
            { name: AI_QADAM_NAME, version: PUBLISHED_VERSION },
        ])
    })

    it('carries an AI qadam step forward to the republished version', async () => {
        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
        expect(migrated.schemaVersion).toBe('26')
    })

    // v24 is the one that must not be edited, and this is why: a flow stamped '25' by it can only be
    // rescued by a migration that starts there.
    it('starts where v24 left off', () => {
        expect(migrateV25AiQadamVersionRedo.targetSchemaVersion).toBe('25')
    })

    // Same reasoning as v24: a constant would strand any flow read after a later republish, because
    // these run lazily and a version still sitting below 26 arrives long after the number is written.
    it('pins whatever version the live registry currently holds, not a number of its own', async () => {
        mockRegistry.mockResolvedValue([{ name: AI_QADAM_NAME, version: '1.2.3' }])

        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(readPins(migrated).ai).toBe('1.2.3')
    })

    it('leaves the pin alone when the registry holds no AI qadam entry', async () => {
        mockRegistry.mockResolvedValue([{ name: '@aiqadam/qadam-slack', version: '0.9.0' }])

        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(readPins(migrated).ai).toBe('0.4.4')
        expect(migrated.schemaVersion).toBe('26')
    })

    it('leaves every other qadam pin alone', async () => {
        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(readPins(migrated).slack).toBe('0.2.0')
    })

    it('rewrites a pin far older than the version before the republish', async () => {
        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.1.0' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
    })

    it('rewrites nothing on a step that is not a qadam action', async () => {
        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({
            schemaVersion: '25',
            aiQadamVersion: '0.4.4',
            aiStepType: FlowTriggerType.PIECE,
        }))

        expect(readPins(migrated).ai).toBe('0.4.4')
    })

    // The new prop is optional and absent means "the row the provider name resolves to", so there is
    // nothing to write into a stored step — and writing one would pick a row on the operator's behalf.
    it('writes no provider reference into a step it repins', async () => {
        const migrated = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(readAiInput(migrated)).toEqual({ provider: 'custom', model: 'llama-3' })
    })

    it('changes nothing on a second pass', async () => {
        const once = await migrateV25AiQadamVersionRedo.migrate(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))
        const twice = await migrateV25AiQadamVersionRedo.migrate({ ...once, schemaVersion: '25' })

        expect(twice.trigger).toEqual(once.trigger)
        expect(twice.schemaVersion).toBe(once.schemaVersion)
    })

    it('is reachable from the chain, so a version at 24 lands on the latest with its pin rewritten', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).ai).toBe(PUBLISHED_VERSION)
    })

    it('is reachable from the chain for a version stamped 25 by v24', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '25', aiQadamVersion: '0.4.4' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).ai).toBe(PUBLISHED_VERSION)
    })
})

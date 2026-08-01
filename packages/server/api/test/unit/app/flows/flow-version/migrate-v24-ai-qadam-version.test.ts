import { readFileSync } from 'fs'
import path from 'path'
import { FlowActionType, FlowVersion, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { AI_QADAM_NAME, AI_QADAM_VERSION, migrateV24AiQadamVersion } from '../../../../../src/app/flows/flow-version/migrations/migrate-v24-ai-qadam-version'

// The bundled qadam registry holds exactly one version per qadam name, and `findExactVersion`
// resolves an exact pin `X` inside `[X, next-patch(X))`. So the moment `@aiqadam/qadam-ai` is
// republished at a new version, every stored step still pinned at the old one resolves to nothing
// and `flow-version-validator-util` throws `qadam_metadata_not_found`. This migration is what
// carries those pins forward, following `migrate-v15-agent-provider-model.ts`.
function flowVersionWithSteps({ schemaVersion, aiQadamVersion }: { schemaVersion: string, aiQadamVersion: string }): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'agent flow',
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
                displayName: 'Run Agent',
                settings: {
                    qadamName: AI_QADAM_NAME,
                    qadamVersion: aiQadamVersion,
                    actionName: 'run_agent',
                    input: { aiProviderModel: { provider: 'custom', model: 'llama-3' } },
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

describe('migrateV24AiQadamVersion', () => {
    it('carries an AI qadam step forward to the republished version', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).ai).toBe(AI_QADAM_VERSION)
        expect(migrated.schemaVersion).toBe('25')
    })

    it('leaves every other qadam pin alone', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).slack).toBe('0.2.0')
    })

    // Lazy on-read migrations run against user data, and a re-run must not be able to produce a
    // different tree than the first pass did.
    it('changes nothing on a second pass', async () => {
        const once = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))
        const twice = await migrateV24AiQadamVersion.migrate({ ...once, schemaVersion: '24' })

        expect(twice.trigger).toEqual(once.trigger)
        expect(twice.schemaVersion).toBe(once.schemaVersion)
    })

    it('is reachable from the chain, so a version at 24 lands on the latest with its pin rewritten', async () => {
        const applied = await flowMigrations.apply(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
        expect(readPins(applied).ai).toBe(AI_QADAM_VERSION)
    })

    // The pin and the published version are two numbers that must agree, in two packages. Nothing
    // else fails when they drift — the flow just stops validating on the next read.
    it('pins the version the AI qadam actually publishes', () => {
        const manifestPath = path.resolve(__dirname, '../../../../../../../qadams/community/ai/package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name: string, version: string }

        expect(manifest.name).toBe(AI_QADAM_NAME)
        expect(manifest.version).toBe(AI_QADAM_VERSION)
    })
})

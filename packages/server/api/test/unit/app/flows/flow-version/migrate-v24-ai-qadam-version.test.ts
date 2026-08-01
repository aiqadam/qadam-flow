import { FlowActionType, FlowTriggerType, FlowVersion, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRegistry = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { registry: typeof mockRegistry } => ({ registry: mockRegistry }),
}))

import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { AI_QADAM_NAME, migrateV24AiQadamVersion } from '../../../../../src/app/flows/flow-version/migrations/migrate-v24-ai-qadam-version'

// The bundled qadam registry holds exactly one version per qadam name, and `findExactVersion`
// resolves an exact pin `X` inside `[X, next-patch(X))`. So the moment `@aiqadam/qadam-ai` is
// republished at a new version, every stored step still pinned at the old one resolves to nothing
// and `flow-version-validator-util` throws `qadam_metadata_not_found`. This migration is what
// carries those pins forward, following `migrate-v15-agent-provider-model.ts`.
const PUBLISHED_VERSION = '0.4.4'

function flowVersionWithSteps({ schemaVersion, aiQadamVersion, aiStepType = FlowActionType.PIECE }: { schemaVersion: string, aiQadamVersion: string, aiStepType?: string }): FlowVersion {
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
                type: aiStepType,
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
    beforeEach(() => {
        vi.clearAllMocks()
        mockRegistry.mockResolvedValue([
            { name: '@aiqadam/qadam-slack', version: '0.9.0' },
            { name: AI_QADAM_NAME, version: PUBLISHED_VERSION },
        ])
    })

    it('carries an AI qadam step forward to the republished version', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
        expect(migrated.schemaVersion).toBe('25')
    })

    // The version is read from the live registry rather than written down in the migration. A
    // constant would strand any flow read after a later republish — these run lazily, so a version
    // still sitting below 25 arrives long after the number was written.
    it('pins whatever version the live registry currently holds, not a number of its own', async () => {
        mockRegistry.mockResolvedValue([{ name: AI_QADAM_NAME, version: '0.9.7' }])

        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).ai).toBe('0.9.7')
    })

    // A pin the registry cannot resolve is broken either way; clearing it during a registry reload
    // would turn a recoverable state into a stored one.
    it('leaves the pin alone when the registry holds no AI qadam entry', async () => {
        mockRegistry.mockResolvedValue([{ name: '@aiqadam/qadam-slack', version: '0.9.0' }])

        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).ai).toBe('0.4.3')
        expect(migrated.schemaVersion).toBe('25')
    })

    it('leaves every other qadam pin alone', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.4.3' }))

        expect(readPins(migrated).slack).toBe('0.2.0')
    })

    // The unconditional rewrite is the part the PR spends most words defending, and every other
    // fixture here pins the version immediately before the republish — so nothing exercised an
    // older pin. `migrate-v15-agent-provider-model.ts:17` writes exactly this one.
    it('rewrites a pin far older than the version before the republish', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({ schemaVersion: '24', aiQadamVersion: '0.1.0' }))

        expect(readPins(migrated).ai).toBe(PUBLISHED_VERSION)
    })

    // A PIECE trigger carries `qadamName`/`qadamVersion` in the same shape an action does, and
    // `transferFlow` visits it. `@aiqadam/qadam-ai` publishes no trigger, so a step of any other
    // type wearing its name is not something to rewrite.
    it('rewrites nothing on a step that is not a qadam action', async () => {
        const migrated = await migrateV24AiQadamVersion.migrate(flowVersionWithSteps({
            schemaVersion: '24',
            aiQadamVersion: '0.4.3',
            aiStepType: FlowTriggerType.PIECE,
        }))

        expect(readPins(migrated).ai).toBe('0.4.3')
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
        expect(readPins(applied).ai).toBe(PUBLISHED_VERSION)
    })
})

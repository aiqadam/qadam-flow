import { AgentQadamProps, AgentToolType, FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { migrateV16AgentQadamToolNames } from '../../../../../src/app/flows/flow-version/migrations/migrate-v16-agent-piece-tool-names'

function agentFlowVersion({ schemaVersion, agentTools }: { schemaVersion: string, agentTools: unknown }): FlowVersion {
    return {
        id: 'flow-version-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'agent flow',
        valid: true,
        state: 'DRAFT',
        schemaVersion,
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
                    qadamName: '@aiqadam/qadam-ai',
                    qadamVersion: '0.1.0',
                    actionName: 'run_agent',
                    input: {
                        [AgentQadamProps.AGENT_TOOLS]: agentTools,
                    },
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readInput(version: FlowVersion): Record<string, unknown> {
    const step = (version.trigger as unknown as { nextAction: { settings: { input: Record<string, unknown> } } }).nextAction
    return step.settings.input
}

// #1028: `step.settings.input` is `z.record(z.string(), z.unknown())` — nothing upstream
// guarantees `agentTools` is an array. Before this fix, `tools.map` threw `TypeError` on a string
// or an object, which `flowVersionMigrationService.migrate` rethrows and pages on-call for, 500ing
// every read of that flow version.
describe('migrateV16AgentQadamToolNames — #1028', () => {
    it('still renames a PIECE tool when agentTools is a proper array', async () => {
        const version = agentFlowVersion({
            schemaVersion: '15',
            agentTools: [{
                type: AgentToolType.PIECE,
                toolName: 'legacy_name',
                pieceMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const migrated = await migrateV16AgentQadamToolNames.migrate(version)
        const tools = readInput(migrated)[AgentQadamProps.AGENT_TOOLS] as { toolName: string }[]

        expect(tools[0].toolName).not.toBe('legacy_name')
        expect(migrated.schemaVersion).toBe('17')
    })

    it.each([
        ['a string', 'not-an-array'],
        ['an object', { foo: 'bar' }],
    ])('leaves the step untouched when agentTools is %s', async (_label, agentTools) => {
        const version = agentFlowVersion({ schemaVersion: '15', agentTools })

        const migrated = await migrateV16AgentQadamToolNames.migrate(version)

        expect(readInput(migrated)[AgentQadamProps.AGENT_TOOLS]).toEqual(agentTools)
        expect(migrated.schemaVersion).toBe('17')
    })

    // `null`/`undefined` already went through the pre-existing `?? []` fallback and never threw —
    // this pins that it still migrates to an empty array rather than being left as `null`.
    it('migrates a null agentTools to an empty array', async () => {
        const version = agentFlowVersion({ schemaVersion: '15', agentTools: null })

        const migrated = await migrateV16AgentQadamToolNames.migrate(version)

        expect(readInput(migrated)[AgentQadamProps.AGENT_TOOLS]).toEqual([])
    })
})

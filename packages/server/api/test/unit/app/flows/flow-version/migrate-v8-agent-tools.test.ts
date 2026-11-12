import { AgentQadamProps, FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { cleanUpAgentTools } from '../../../../../src/app/flows/flow-version/migrations/migrate-v8-agent-tools'

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
                    qadamName: '@aiqadam/qadam-agent',
                    qadamVersion: '0.1.0',
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
describe('cleanUpAgentTools — #1028', () => {
    it('migrates an array of PIECE and FLOW tools as before', async () => {
        const version = agentFlowVersion({
            schemaVersion: '8',
            agentTools: [
                {
                    type: 'PIECE',
                    toolName: 'slack_tool',
                    qadamMetadata: {
                        qadamName: '@aiqadam/qadam-slack',
                        qadamVersion: '0.1.0',
                        actionName: 'send_channel_message',
                        connectionExternalId: 'conn-1',
                    },
                },
                { type: 'FLOW', toolName: 'flow_tool', flowId: 'flow-2' },
            ],
        })

        const migrated = await cleanUpAgentTools.migrate(version)
        const tools = readInput(migrated)[AgentQadamProps.AGENT_TOOLS] as Record<string, unknown>[]

        expect(tools).toHaveLength(2)
        expect(migrated.schemaVersion).toBe('9')
    })

    it.each([
        ['a string', 'not-an-array'],
        ['an object', { foo: 'bar' }],
    ])('leaves the step untouched when agentTools is %s', async (_label, agentTools) => {
        const version = agentFlowVersion({ schemaVersion: '8', agentTools })

        const migrated = await cleanUpAgentTools.migrate(version)

        expect(readInput(migrated)[AgentQadamProps.AGENT_TOOLS]).toEqual(agentTools)
        expect(migrated.schemaVersion).toBe('9')
    })

    // `null`/`undefined` already went through the pre-existing `?? []` fallback and never threw —
    // this pins that it still migrates to an empty array rather than being left as `null`.
    it('migrates a null agentTools to an empty array', async () => {
        const version = agentFlowVersion({ schemaVersion: '8', agentTools: null })

        const migrated = await cleanUpAgentTools.migrate(version)

        expect(readInput(migrated)[AgentQadamProps.AGENT_TOOLS]).toEqual([])
    })
})

import { AgentQadamProps, AgentToolType, FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { migrateV16AgentQadamToolNames } from '../../../../../src/app/flows/flow-version/migrations/migrate-v16-agent-piece-tool-names'
import { migrateV23AgentQadamToolNamesRedo } from '../../../../../src/app/flows/flow-version/migrations/migrate-v23-agent-piece-tool-names-redo'

// #247: v16 read `tool.qadamMetadata`, which no producer writes — the schema calls it
// `pieceMetadata` — so its PIECE branch never fired. Optional chaining meant it did not throw and
// nothing logged, so it reported success while doing nothing for the tool type in its own
// filename. v16 is fixed for anyone who still has to pass through it; v23 redoes the PIECE rename
// for versions already stamped past 16, which will never run v16 again.
function agentFlowVersion({ schemaVersion, toolName }: { schemaVersion: string, toolName: string }): FlowVersion {
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
                        [AgentQadamProps.AGENT_TOOLS]: [{
                            type: AgentToolType.PIECE,
                            toolName,
                            pieceMetadata: {
                                qadamName: '@aiqadam/qadam-slack',
                                qadamVersion: '0.1.0',
                                actionName: 'send_channel_message',
                            },
                        }],
                    },
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readToolName(version: FlowVersion): string {
    const step = (version.trigger as unknown as { nextAction: { settings: { input: Record<string, { toolName: string }[]> } } }).nextAction
    return step.settings.input[AgentQadamProps.AGENT_TOOLS][0].toolName
}

describe('agent PIECE tool names — #247', () => {
    // The regression test for the typo itself. Before the fix this stayed at the legacy name,
    // silently, and there was no test to notice.
    it('v16 now renames a PIECE tool instead of falling through', async () => {
        const migrated = await migrateV16AgentQadamToolNames.migrate(agentFlowVersion({ schemaVersion: '15', toolName: 'legacy_name' }))

        expect(readToolName(migrated)).not.toBe('legacy_name')
        expect(readToolName(migrated)).toContain('send_channel_message')
    })

    it('v23 finishes the job for a version that already passed the broken v16', async () => {
        const migrated = await migrateV23AgentQadamToolNamesRedo.migrate(agentFlowVersion({ schemaVersion: '23', toolName: 'legacy_name' }))

        expect(readToolName(migrated)).not.toBe('legacy_name')
        expect(migrated.schemaVersion).toBe('24')
    })

    // Anyone who somehow already has the right name must not have it changed again, or an install
    // that ran this twice would end up with a different name than one that ran it once.
    it('v23 is idempotent', async () => {
        const once = await migrateV23AgentQadamToolNamesRedo.migrate(agentFlowVersion({ schemaVersion: '23', toolName: 'legacy_name' }))
        const twice = await migrateV23AgentQadamToolNamesRedo.migrate(agentFlowVersion({ schemaVersion: '23', toolName: readToolName(once) }))

        expect(readToolName(twice)).toBe(readToolName(once))
    })

    it('v23 leaves a tool with no piece metadata alone', async () => {
        const version = agentFlowVersion({ schemaVersion: '23', toolName: 'flow_tool' })
        const tools = (version.trigger as unknown as { nextAction: { settings: { input: Record<string, Record<string, unknown>[]> } } })
            .nextAction.settings.input[AgentQadamProps.AGENT_TOOLS]
        tools[0] = { type: AgentToolType.FLOW, toolName: 'flow_tool' }

        const migrated = await migrateV23AgentQadamToolNamesRedo.migrate(version)

        expect(readToolName(migrated)).toBe('flow_tool')
    })
})

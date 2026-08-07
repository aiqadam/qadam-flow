import { AgentQadamProps, AgentToolType, FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { migrateV29AgentToolMetadataQadamRebrand } from '../../../../../src/app/flows/flow-version/migrations/migrate-v29-agent-tool-metadata-qadam-rebrand'

// Rebrand-back: `pieceMetadata` was the interim name migrate-v26 (#295/#316) propagated from
// #246's engine-read rename. Every other metadata construct in this codebase is `qadam*` —
// this migration (and the matching schema/engine/web rename) restores that for agent PIECE tools.
function agentFlowVersion({ schemaVersion, tools, qadamName = '@aiqadam/qadam-ai', actionName = 'run_agent' }: { schemaVersion: string, tools: Record<string, unknown>[], qadamName?: string, actionName?: string }): FlowVersion {
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
                    qadamName,
                    qadamVersion: '0.1.0',
                    actionName,
                    input: {
                        [AgentQadamProps.AGENT_TOOLS]: tools,
                    },
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readTools(version: FlowVersion): Record<string, unknown>[] {
    const step = (version.trigger as unknown as { nextAction: { settings: { input: Record<string, Record<string, unknown>[]> } } }).nextAction
    return step.settings.input[AgentQadamProps.AGENT_TOOLS]
}

describe('agent PIECE tool metadata qadam rebrand', () => {
    // The core case: any flow sitting on the interim `pieceMetadata` key (every flow that reached
    // v27+ before this migration existed) comes out with `qadamMetadata` instead, matching the
    // schema/engine/web rename that shipped alongside this migration.
    it('renames pieceMetadata to qadamMetadata on a PIECE agent tool', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'current_tool',
                pieceMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)
        const [tool] = readTools(migrated)

        expect(tool.pieceMetadata).toBeUndefined()
        expect(tool.qadamMetadata).toEqual({
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '0.1.0',
            actionName: 'send_channel_message',
        })
        expect(migrated.schemaVersion).toBe('30')
    })

    // A tool that already carries `qadamMetadata` — impossible today since nothing writes it yet,
    // but a flow that somehow reaches this migration twice must not lose data on the second pass.
    it('leaves a tool that already has qadamMetadata untouched', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'current_tool',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // If both fields are somehow present, the already-correct `qadamMetadata` wins and the stale
    // `pieceMetadata` is left in place rather than silently dropped — mirrors v26's own guard.
    it('leaves qadamMetadata alone when both fields are present', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'both_fields_tool',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
                pieceMetadata: {
                    qadamName: '@aiqadam/qadam-slack-legacy',
                    qadamVersion: '0.0.9',
                    actionName: 'legacy_send',
                },
            }],
        })

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)
        const [tool] = readTools(migrated)

        expect(tool.qadamMetadata).toEqual({
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '0.1.0',
            actionName: 'send_channel_message',
        })
    })

    // Non-PIECE tools (FLOW/MCP) never had either field — must not be touched or crash.
    it('leaves FLOW and MCP tools alone', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [
                { type: AgentToolType.FLOW, toolName: 'flow_tool', externalFlowId: 'flow-2' },
                { type: AgentToolType.MCP, toolName: 'mcp_tool' },
            ],
        })

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // A PIECE tool with neither field must not be guessed at.
    it('leaves a PIECE tool with no metadata field alone', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [{ type: AgentToolType.PIECE, toolName: 'bare_tool' }],
        })

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // An unrelated PIECE step with no agentTools input at all must be left alone.
    it('leaves an unrelated PIECE step without an agentTools input untouched', async () => {
        const version: FlowVersion = {
            id: 'flow-version-1',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            flowId: 'flow-1',
            displayName: 'unrelated flow',
            valid: true,
            state: 'DRAFT',
            schemaVersion: '29',
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
                    displayName: 'Send Slack Message',
                    settings: {
                        qadamName: '@aiqadam/qadam-slack',
                        qadamVersion: '0.1.0',
                        actionName: 'send_channel_message',
                        input: { channel: 'general' },
                        inputUiInfo: {},
                    },
                },
            },
        } as unknown as FlowVersion

        const migrated = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)

        expect(migrated.trigger).toEqual(version.trigger)
    })

    // Safe to apply twice: after the first pass the tool only has `qadamMetadata`, so a second pass
    // must be a no-op.
    it('is idempotent', async () => {
        const version = agentFlowVersion({
            schemaVersion: '29',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'current_tool',
                pieceMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const once = await migrateV29AgentToolMetadataQadamRebrand.migrate(version)
        const twice = await migrateV29AgentToolMetadataQadamRebrand.migrate({ ...once, schemaVersion: '29' })

        expect(readTools(twice)).toEqual(readTools(once))
    })
})

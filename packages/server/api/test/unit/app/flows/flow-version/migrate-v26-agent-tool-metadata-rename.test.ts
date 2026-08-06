import { AgentQadamProps, AgentToolType, FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { migrateV26AgentToolMetadataRename } from '../../../../../src/app/flows/flow-version/migrations/migrate-v26-agent-tool-metadata-rename'

// #295: v7/v8 wrote agent PIECE tool metadata under `qadamMetadata`. The shared schema (and every
// engine read since #246) only knows `pieceMetadata`, and no migration ever renamed the stored
// field — a v7/v8-shaped tool reaches the engine unchanged and throws `TypeError` on
// `tool.pieceMetadata.qadamName`. This is the rename that was missing.
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

describe('agent PIECE tool metadata rename — #295', () => {
    // The regression test for the bug itself: a v7/v8-shaped stored tool, still carrying the legacy
    // `qadamMetadata` field, must come out with `pieceMetadata` instead so the engine read
    // (`tool.pieceMetadata.qadamName`) does not throw.
    it('renames qadamMetadata to pieceMetadata on a legacy v7/v8-shaped PIECE tool', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'legacy_tool',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)
        const [tool] = readTools(migrated)

        expect(tool.qadamMetadata).toBeUndefined()
        expect(tool.pieceMetadata).toEqual({
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '0.1.0',
            actionName: 'send_channel_message',
        })
        expect(migrated.schemaVersion).toBe('27')
    })

    // v7/v8 never rename the step's own `qadamName` away from the legacy `@aiqadam/qadam-agent` they
    // match on, and no later migration does either — so the rename must not be gated on
    // `qadamName === '@aiqadam/qadam-ai'` (the filter v16/v23 use) or it would skip exactly the
    // cohort it exists to fix.
    it('renames a legacy tool under a step still named @aiqadam/qadam-agent', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            qadamName: '@aiqadam/qadam-agent',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'legacy_tool',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)
        const [tool] = readTools(migrated)

        expect(tool.qadamMetadata).toBeUndefined()
        expect(tool.pieceMetadata).toEqual({
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '0.1.0',
            actionName: 'send_channel_message',
        })
    })

    // A tool that already carries `pieceMetadata` (every install that never touched v7/v8) must be
    // left untouched — this migration only renames, it never overwrites a correct field.
    it('leaves a tool that already has pieceMetadata untouched', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
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

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // A tool that somehow carries both fields must not have its correct `pieceMetadata` overwritten
    // by the stale `qadamMetadata` sitting next to it — `pieceMetadata` wins, and the leftover
    // `qadamMetadata` is left in place rather than silently dropped. This is the case the
    // `!isNil(tool.pieceMetadata)` guard exists for, distinct from "pieceMetadata only".
    it('leaves pieceMetadata alone when both fields are present', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'both_fields_tool',
                pieceMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack-legacy',
                    qadamVersion: '0.0.9',
                    actionName: 'legacy_send',
                },
            }],
        })

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)
        const [tool] = readTools(migrated)

        expect(tool.pieceMetadata).toEqual({
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '0.1.0',
            actionName: 'send_channel_message',
        })
    })

    // Non-PIECE tools (FLOW/MCP) never had a `qadamMetadata` field to begin with — must not be
    // touched or crash on the missing key.
    it('leaves FLOW and MCP tools alone', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            tools: [
                { type: AgentToolType.FLOW, toolName: 'flow_tool', externalFlowId: 'flow-2' },
                { type: AgentToolType.MCP, toolName: 'mcp_tool' },
            ],
        })

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // A PIECE tool with neither field must not be guessed at — leave it exactly as found rather than
    // synthesizing metadata that was never there.
    it('leaves a PIECE tool with no metadata field alone', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            tools: [{ type: AgentToolType.PIECE, toolName: 'bare_tool' }],
        })

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)

        expect(readTools(migrated)).toEqual(readTools(version))
    })

    // Widening the filter to "any PIECE step" (dropping the qadamName/actionName check) must not
    // reach into an unrelated piece step that has no `agentTools` input at all.
    it('leaves an unrelated PIECE step without an agentTools input untouched', async () => {
        const version: FlowVersion = {
            id: 'flow-version-1',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            flowId: 'flow-1',
            displayName: 'unrelated flow',
            valid: true,
            state: 'DRAFT',
            schemaVersion: '26',
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

        const migrated = await migrateV26AgentToolMetadataRename.migrate(version)

        expect(migrated.trigger).toEqual(version.trigger)
    })

    // Safe to apply twice: after the first pass the tool only has `pieceMetadata`, so a second pass
    // must be a no-op rather than re-wrapping or dropping data.
    it('is idempotent', async () => {
        const version = agentFlowVersion({
            schemaVersion: '26',
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'legacy_tool',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '0.1.0',
                    actionName: 'send_channel_message',
                },
            }],
        })

        const once = await migrateV26AgentToolMetadataRename.migrate(version)
        const twice = await migrateV26AgentToolMetadataRename.migrate({ ...once, schemaVersion: '26' })

        expect(readTools(twice)).toEqual(readTools(once))
    })
})

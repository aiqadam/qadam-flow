import { McpToolDefinition, ProjectScopedMcpServer } from '@aiqadam/shared'
import { dynamicTool, Tool, ToolSet } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { PermissionChecker, resolvePermissionChecker } from '../mcp/mcp-permissions'
import { LOCKED_TOOL_NAMES, qadamFlowTools } from '../mcp/tools'

export const chatTools = {
    async build({ mcp, userId, log }: BuildParams): Promise<ToolSet> {
        const permissionChecker = await resolvePermissionChecker({ userId, projectId: mcp.projectId })
        const disabledToolSet = new Set(mcp.disabledTools ?? [])
        // Same rule as mcp-server-builder.ts:172 — a locked tool stays available even when it is
        // listed as disabled, everything else honours the project's `disabledTools`. Chat must not
        // be a side door onto a tool the project switched off in its MCP settings.
        const enabledTools = qadamFlowTools(mcp, userId, log)
            .filter((tool) => LOCKED_TOOL_NAMES.includes(tool.title) || !disabledToolSet.has(tool.title))

        const entries = enabledTools.map((tool) => [tool.title, toAiSdkTool({ tool, permissionChecker })])

        return {
            ...Object.fromEntries(entries),
            [THINKING_STATUS_TOOL_NAME]: thinkingStatusTool,
        }
    },
}

const THINKING_STATUS_TOOL_NAME = 'ap_update_thinking_status'

// Chat-only, and deliberately a no-op server side: its whole payload is the `status` string, which
// `chatAiUtils.buildStepParts` lifts out of the tool call into a THINKING_STATUS part and the web
// UI renders above the tool pill. The system prompt requires one before every other tool call, so
// it has to exist as a real registered tool or every turn fails with an unknown-tool error.
const thinkingStatusTool = dynamicTool({
    title: THINKING_STATUS_TOOL_NAME,
    description: 'Tell the user, in one warm first-person sentence, what you are about to do. Call this immediately before every other tool call.',
    inputSchema: z.object({
        status: z.string().describe('One short sentence describing your goal for the user. Never progressive tense, never a tool or app name.'),
    }),
    execute: async () => ({ success: true }),
})

function toAiSdkTool({ tool, permissionChecker }: { tool: McpToolDefinition, permissionChecker: PermissionChecker }): Tool {
    const execute = permissionChecker.wrapExecute({
        execute: tool.execute,
        permission: tool.permission,
        toolTitle: tool.title,
    })
    return dynamicTool({
        title: tool.title,
        description: tool.description,
        // `inputSchema` on an McpToolDefinition is a raw Zod shape, which is what the MCP SDK
        // takes; the AI SDK wants a schema, so it is wrapped rather than redeclared.
        inputSchema: z.object(tool.inputSchema),
        execute: async (input) => execute(toRecord(input)),
    })
}

function toRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {}
    }
    return { ...value }
}

type BuildParams = {
    mcp: ProjectScopedMcpServer
    userId: string
    log: FastifyBaseLogger
}

import {
    AppConnectionStatus,
    McpToolDefinition,
    Permission,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { appConnectionService } from '../../app-connection/app-connection-service/app-connection-service'
import { projectService } from '../../project/project-service'
import { mcpUtils } from './mcp-utils'

const statusEnum = z.enum(Object.values(AppConnectionStatus) as [AppConnectionStatus, ...AppConnectionStatus[]])

const listConnectionsSchema = z.object({
    qadamName: z
        .string()
        .optional()
        .describe(
            'Filter by piece name. Short names like "slack" or "google-drive" are auto-expanded to full format (e.g. "@aiqadam/qadam-slack"). You can also pass the full name directly.',
        ),
    displayName: z
        .string()
        .optional()
        .describe(
            'Filter by connection display name (partial, case-insensitive match). Use to find a connection by its label, e.g. "My Gmail" or "Slack workspace".',
        ),
    status: z
        .array(statusEnum)
        .optional()
        .describe(
            'Filter by status: ACTIVE (working), MISSING (deleted or inaccessible), ERROR (auth/refresh failed). Omit to return all statuses.',
        ),
})

export const apListConnectionsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_list_connections',
        permission: Permission.READ_APP_CONNECTION,
        description:
            'List OAuth/app connections in the project. Returns externalId needed for the auth parameter on steps.',
        inputSchema: {
            qadamName: listConnectionsSchema.shape.qadamName,
            displayName: listConnectionsSchema.shape.displayName,
            status: listConnectionsSchema.shape.status,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const params = listConnectionsSchema.parse(args ?? {})
                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const connections = await appConnectionService(log).list({
                    projectId: mcp.projectId,
                    platformId: project.platformId,
                    cursorRequest: null,
                    scope: undefined,
                    displayName: params.displayName,
                    status: params.status,
                    qadamName: mcpUtils.normalizeQadamName(params.qadamName),
                    limit: 200,
                    externalIds: undefined,
                })
                // `externalId` and `qadamName` are `z.string()` with no format constraint — set by
                // whoever creates the connection (the UI's own externalId field is free text) — so a
                // newline plus a fabricated `- externalId: ...` line would forge a complete extra
                // list entry, the exact attack this wrap exists to stop, on the very line that lists
                // connections (#485 review). Wrapping both here is safe for the copy-back use this
                // tool's own description promises ("Returns externalId needed for the auth
                // parameter"): `structuredContent.connections[]` below carries both raw and
                // unwrapped, so an agent that needs the exact value for `auth` reads it from there.
                const lines = connections.data.map(c => `- externalId: ${mcpUtils.wrapUntrustedValue(c.externalId)} | displayName: ${mcpUtils.wrapUntrustedValue(c.displayName)} | qadam: ${mcpUtils.wrapUntrustedValue(c.qadamName)} | status: ${c.status} | scope: ${c.scope}`)
                const structured = {
                    connections: connections.data.map(c => ({
                        externalId: c.externalId,
                        displayName: c.displayName,
                        qadamName: c.qadamName,
                        status: c.status,
                        scope: c.scope,
                    })),
                    count: connections.data.length,
                }
                return {
                    content: [{
                        type: 'text',
                        text: `✅ Listed ${lines.length} connection(s):\n${lines.join('\n')}`,
                    }],
                    structuredContent: structured,
                }
            }
            catch (err) {
                return mcpUtils.mcpToolError('Failed to list connections', err)
            }
        },
    }
}
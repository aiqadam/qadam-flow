import { McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { mcpUtils } from './mcp-utils'

const exportFlowInput = z.object({
    flowId: z.string(),
})

export const apExportFlowTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_export_flow',
        permission: Permission.READ_FLOW,
        description: 'Export a flow as a SharedTemplate JSON, the same shape used by the flow templates gallery. Never contains a connection value or variable value — no secret is ever included. Step inputs that reference a connection are cleared, but the flow-level list of referenced connection ids is retained as-is; sample data is stripped. Use ap_import_flow to re-apply it, in this project or another one.',
        inputSchema: exportFlowInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { flowId } = exportFlowInput.parse(args)

                const template = await flowService(log).getTemplate({
                    flowId,
                    projectId: mcp.projectId,
                    userMetadata: null,
                    versionId: undefined,
                })

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(template, null, 2),
                    }],
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_export_flow failed')
                return mcpUtils.mcpToolError('Failed to export flow', err)
            }
        },
    }
}

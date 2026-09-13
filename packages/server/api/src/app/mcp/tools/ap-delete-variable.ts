import { isNil, McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { variableService } from '../../variable/variable.service'
import { mcpUtils } from './mcp-utils'

const deleteVariableInput = z.object({
    name: z.string().optional().describe('Exact variable name to delete. Provide exactly one of name or id.'),
    id: z.string().optional().describe('Variable id to delete. Provide exactly one of name or id.'),
})

export const apDeleteVariableTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_delete_variable',
        permission: Permission.WRITE_VARIABLE,
        description: 'Permanently delete a project variable, by name or id.',
        inputSchema: deleteVariableInput.shape,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { name, id } = deleteVariableInput.parse(args)

                if ((isNil(name) && isNil(id)) || (!isNil(name) && !isNil(id))) {
                    return { content: [{ type: 'text', text: '❌ Provide exactly one of name or id.' }] }
                }

                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const platformId = project.platformId

                let targetId = id
                if (!isNil(name)) {
                    const found = await variableService(log).getByNameOrNull({ projectId: mcp.projectId, platformId, name })
                    if (!found) {
                        return { content: [{ type: 'text', text: `❌ Variable "${name}" not found.` }] }
                    }
                    targetId = found.id
                }
                if (isNil(targetId)) {
                    return { content: [{ type: 'text', text: '❌ Provide exactly one of name or id.' }] }
                }

                const deleted = await variableService(log).delete({ id: targetId, projectId: mcp.projectId, platformId })

                return { content: [{ type: 'text', text: `✅ Variable "${deleted.name}" deleted.` }] }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_delete_variable failed')
                return mcpUtils.mcpToolError('Failed to delete variable', err)
            }
        },
    }
}

import { McpToolDefinition, Permission, ProjectScopedMcpServer, VariableWithoutSensitiveData } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { variableService } from '../../variable/variable.service'
import { mcpUtils } from './mcp-utils'

const listVariablesInput = z.object({
    name: z.string().optional().describe('Filter by name (substring match).'),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(100).optional().describe('Max results per page (1-100). Defaults to 10.'),
})

export const apListVariablesTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_list_variables',
        permission: Permission.READ_VARIABLE,
        description: 'List project variables (name and metadata only — values are never returned by this tool). Use ap_upsert_variable to create or rotate one.',
        inputSchema: listVariablesInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { name, cursor, limit } = listVariablesInput.parse(args)

                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const result = await variableService(log).list({
                    projectId: mcp.projectId,
                    platformId: project.platformId,
                    cursor,
                    limit,
                    name,
                })

                if (result.data.length === 0) {
                    return { content: [{ type: 'text', text: 'No variables found in this project.' }] }
                }

                const lines = result.data.map((variable) => formatVariableLine(variable))
                return { content: [{ type: 'text', text: lines.join('\n') }] }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_list_variables failed')
                return mcpUtils.mcpToolError('Failed to list variables', err)
            }
        },
    }
}

function formatVariableLine(variable: VariableWithoutSensitiveData): string {
    const owner = variable.owner ? ` — owner: ${variable.owner.email}` : ''
    return `- ${variable.name} (id: ${variable.id}) — reference: {{variables['${variable.name}']}}, created: ${variable.created}, updated: ${variable.updated}${owner}`
}

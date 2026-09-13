import { ErrorCode, McpToolDefinition, Permission, ProjectScopedMcpServer, QadamFlowError, VARIABLE_NAME_REGEX } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { variableService } from '../../variable/variable.service'
import { mcpUtils } from './mcp-utils'

const upsertVariableInput = z.object({
    name: z.string().min(1, 'formErrors.required').regex(VARIABLE_NAME_REGEX, 'invalidVariableName').describe('Variable name (alphanumeric + underscore). Used as the mention key: {{variables[\'NAME\']}}.'),
    value: z.string().min(1, 'formErrors.required').describe('The secret value. Never echoed back — only the name and reference string are returned.'),
})

export const apUpsertVariableTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_upsert_variable',
        permission: Permission.WRITE_VARIABLE,
        description: 'Create a project variable, or rotate its value if a variable with that name already exists. Never returns the value — only the name and the {{variables[\'NAME\']}} reference to use in flow inputs.',
        inputSchema: upsertVariableInput.shape,
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { name, value } = upsertVariableInput.parse(args)
                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const platformId = project.platformId

                const existing = await variableService(log).getByNameOrNull({ projectId: mcp.projectId, platformId, name })

                if (existing) {
                    await variableService(log).update({ id: existing.id, projectId: mcp.projectId, platformId, value, metadata: undefined })
                    return successResult({ name, rotated: true })
                }

                try {
                    await variableService(log).create({ projectId: mcp.projectId, platformId, name, value, ownerId: null, metadata: undefined })
                    return successResult({ name, rotated: false })
                }
                catch (createErr) {
                    if (!isDuplicateNameError(createErr)) {
                        throw createErr
                    }
                    // Another writer created the same name between our lookup and the create call — retry as an update.
                    const racedExisting = await variableService(log).getByNameOrNull({ projectId: mcp.projectId, platformId, name })
                    if (!racedExisting) {
                        throw createErr
                    }
                    await variableService(log).update({ id: racedExisting.id, projectId: mcp.projectId, platformId, value, metadata: undefined })
                    return successResult({ name, rotated: true })
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_upsert_variable failed')
                return mcpUtils.mcpToolError('Failed to upsert variable', err)
            }
        },
    }
}

function isDuplicateNameError(err: unknown): boolean {
    return err instanceof QadamFlowError && err.error.code === ErrorCode.VALIDATION
}

function successResult({ name, rotated }: { name: string, rotated: boolean }): { content: [{ type: 'text', text: string }] } {
    const action = rotated ? 'rotated' : 'created'
    return { content: [{ type: 'text', text: `✅ Variable "${name}" ${action}. Reference it as {{variables['${name}']}}.` }] }
}

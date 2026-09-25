import { isNil, McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { translationService } from '../../translation/translation.service'
import { mcpUtils } from './mcp-utils'

const deleteTranslationInput = z.object({
    key: z.string().optional().describe('Exact translation key to delete. Provide exactly one of key or id.'),
    id: z.string().optional().describe('Translation id to delete. Provide exactly one of key or id.'),
})

export const apDeleteTranslationTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_delete_translation',
        permission: Permission.WRITE_TRANSLATION,
        description: 'Permanently delete a project translation key, by key or id. Any flow still referencing it with {{$t[...]}} will fail that step at run time.',
        inputSchema: deleteTranslationInput.shape,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { key, id } = deleteTranslationInput.parse(args)

                if ((isNil(key) && isNil(id)) || (!isNil(key) && !isNil(id))) {
                    return { content: [{ type: 'text', text: '❌ Provide exactly one of key or id.' }] }
                }

                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const platformId = project.platformId

                let targetId = id
                if (!isNil(key)) {
                    const found = await translationService(log).getByKeyOrNull({ projectId: mcp.projectId, platformId, key })
                    if (isNil(found)) {
                        return { content: [{ type: 'text', text: `❌ Translation key "${key}" not found.` }] }
                    }
                    targetId = found.id
                }
                if (isNil(targetId)) {
                    return { content: [{ type: 'text', text: '❌ Provide exactly one of key or id.' }] }
                }

                const deleted = await translationService(log).delete({ id: targetId, projectId: mcp.projectId, platformId })

                return { content: [{ type: 'text', text: `✅ Translation key "${deleted.key}" deleted.` }] }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_delete_translation failed')
                return mcpUtils.mcpToolError('Failed to delete translation', err)
            }
        },
    }
}

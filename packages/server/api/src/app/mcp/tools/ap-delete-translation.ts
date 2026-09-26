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
        description: 'Permanently delete a project translation key, by key or id. Any flow still referencing it with {{$t[...]}} will fail that step at run time — the response lists the flows still referencing it (draft or published) so the caller can warn before it happens.',
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

                // Read before delete, deliberately: the row (and the key `usages` looks up flows
                // by) is gone the instant `delete` returns, so this is the last point the caller can
                // learn which flows were still referencing it.
                const usages = await translationService(log).usages({ id: targetId, projectId: mcp.projectId, platformId })
                const deleted = await translationService(log).delete({ id: targetId, projectId: mcp.projectId, platformId })

                const usageNote = usages.usages.length === 0
                    ? ' No flow referenced it.'
                    : ` ${usages.usages.length} flow(s) still referenced it and will now fail that step: ${usages.usages.map((usage) => mcpUtils.wrapUntrustedValue(usage.flowDisplayName)).join(', ')}.${usages.truncated ? ' (usage scan was truncated — more may exist)' : ''}`

                return {
                    content: [{ type: 'text', text: `✅ Translation key "${deleted.key}" deleted.${usageNote}` }],
                    structuredContent: { deletedKey: deleted.key, usages: usages.usages, truncated: usages.truncated },
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_delete_translation failed')
                return mcpUtils.mcpToolError('Failed to delete translation', err)
            }
        },
    }
}

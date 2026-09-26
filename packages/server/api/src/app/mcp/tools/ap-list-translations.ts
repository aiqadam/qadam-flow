import { McpToolDefinition, Permission, ProjectScopedMcpServer, Translation } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { translationService } from '../../translation/translation.service'
import { mcpUtils } from './mcp-utils'

const listTranslationsInput = z.object({
    key: z.string().optional().describe('Filter by key (substring match).'),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(100).optional().describe('Max results per page (1-100). Defaults to 10.'),
})

export const apListTranslationsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_list_translations',
        permission: Permission.READ_TRANSLATION,
        description: 'List project translation keys and their per-locale values. Use ap_upsert_translations to create or update.',
        inputSchema: listTranslationsInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { key, cursor, limit } = listTranslationsInput.parse(args)

                const project = await projectService(log).getOneOrThrow(mcp.projectId)
                const result = await translationService(log).list({
                    projectId: mcp.projectId,
                    platformId: project.platformId,
                    cursor,
                    limit,
                    key,
                })

                if (result.data.length === 0) {
                    return { content: [{ type: 'text', text: 'No translations found in this project.' }] }
                }

                const lines = result.data.map((translation) => formatTranslationLine(translation))
                return { content: [{ type: 'text', text: lines.join('\n') }] }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_list_translations failed')
                return mcpUtils.mcpToolError('Failed to list translations', err)
            }
        },
    }
}

// `translation.key` is bare, like `variable.name`: `TRANSLATION_KEY_REGEX` constrains it to
// alphanumerics, underscores, dots and hyphens, so it can never carry a space, punctuation the
// reader would need escaping, or a newline.
function formatTranslationLine(translation: Translation): string {
    const locales = Object.keys(translation.values).sort().join(', ') || '(no locales)'
    return `- ${translation.key} (id: ${translation.id}) — reference: {{$t['${translation.key}']}}, locales: ${locales}`
}

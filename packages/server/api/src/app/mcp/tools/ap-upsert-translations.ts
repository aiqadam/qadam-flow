import { formErrors, MAX_TRANSLATION_KEYS_PER_UPSERT, McpToolDefinition, Permission, ProjectScopedMcpServer, TranslationKeySchema, TranslationValues } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { projectService } from '../../project/project-service'
import { translationService } from '../../translation/translation.service'
import { mcpUtils } from './mcp-utils'

const upsertTranslationsInput = z.object({
    translations: z.array(z.object({
        key: TranslationKeySchema.describe('Translation key (letters, digits, underscores, dot-separated segments — e.g. "welcome.title"). Used as the mention key: {{$t[\'key\']}}.'),
        values: TranslationValues.describe('Locale (BCP-47 tag) to value. Merged with any existing values on the key — an omitted locale is left untouched.'),
        description: z.string().optional().describe('Optional note for translators, shown alongside the key.'),
    })).min(1, formErrors.required).max(MAX_TRANSLATION_KEYS_PER_UPSERT),
})

export const apUpsertTranslationsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_upsert_translations',
        permission: Permission.WRITE_TRANSLATION,
        description: 'Create or update project translation keys in a batch. Each key\'s locale values are merged with any already stored — an omitted locale is left untouched, never cleared.',
        inputSchema: upsertTranslationsInput.shape,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { translations } = upsertTranslationsInput.parse(args)
                const project = await projectService(log).getOneOrThrow(mcp.projectId)

                const updated = await translationService(log).upsertBatch({
                    projectId: mcp.projectId,
                    platformId: project.platformId,
                    items: translations,
                })

                const lines = updated.map((translation) => `- ${translation.key} — {{$t['${translation.key}']}}`)
                return { content: [{ type: 'text', text: `✅ Upserted ${updated.length} translation key(s):\n${lines.join('\n')}` }] }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_upsert_translations failed')
                return mcpUtils.mcpToolError('Failed to upsert translations', err)
            }
        },
    }
}

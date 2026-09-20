import { AIProviderModelType, AIProviderName, McpToolDefinition, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { aiProviderService } from '../../ai/ai-provider-service'
import { mcpUtils } from './mcp-utils'

const providerSchema = z.enum(Object.values(AIProviderName) as [AIProviderName, ...AIProviderName[]])

const listAiModelsInput = z.object({
    provider: providerSchema.optional().describe('Filter by provider name. Omit to list all configured providers and their models.'),
})

export const apListAiModelsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_list_ai_models',
        description: 'List configured AI providers and their available models. Use this to discover valid provider, providerId and model values for configuring Run Agent steps. The output shows the provider names and model IDs needed for the aiProviderModel input, plus each provider\'s row id, which pins a step to one specific provider when two of the same type are configured.',
        inputSchema: listAiModelsInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        execute: async (args) => {
            try {
                const { provider: filterProvider } = listAiModelsInput.parse(args)

                const platformId = await mcpUtils.resolvePlatformId({ mcp, log })
                const service = aiProviderService(log)
                // Neither this tool nor `structuredProviders` below reads `config` at all, so it
                // gets the same non-privileged view as the builder's model picker (#297).
                const providers = await service.listProviders({ platformId, includeConfigSecrets: false })

                if (providers.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'No AI providers configured. Ask a platform admin to add one in Settings → AI Providers.' }],
                        structuredContent: { providers: [] },
                    }
                }

                const filteredProviders = filterProvider
                    ? providers.filter(p => p.provider === filterProvider)
                    : providers

                if (filteredProviders.length === 0) {
                    const available = providers.map(p => p.provider).join(', ')
                    return {
                        content: [{ type: 'text', text: `Provider "${filterProvider}" is not configured. Available providers: ${available}` }],
                        structuredContent: { providers: [] },
                    }
                }

                const MAX_MODELS_PER_PROVIDER = 20
                const structuredProviders: Array<{ id: string, provider: string, displayName: string, models: Array<{ id: string, name: string }> }> = []
                const sections = await Promise.all(
                    filteredProviders.map(async (p) => {
                        try {
                            const models = await service.listModels({ platformId, ref: p.id })
                            const textModels = models.filter(m => m.type === AIProviderModelType.TEXT)
                            const capped = textModels.slice(0, MAX_MODELS_PER_PROVIDER)
                            structuredProviders.push({
                                id: p.id,
                                provider: p.provider,
                                displayName: p.name,
                                models: capped.map(m => ({ id: m.id, name: m.name })),
                            })
                            // `m.name` AND `m.id` both come from a live call to the provider's own
                            // `/models` endpoint — for a CUSTOM provider, an operator-supplied base URL —
                            // and `p.name` is the admin-configured display name for the provider row. All
                            // three are `\n`-joined into this nested list, so any of them can forge a fake
                            // provider/model entry (#485). `m.id` is `z.string()` with no constraint
                            // (`AIProviderModel`), so wrapping only the name would leave the same channel
                            // open one field to the right. `p.id`/`p.provider` are an apId and an enum.
                            // The raw ids stay in `structuredContent` above for the model to copy back.
                            const modelLines = capped.length > 0
                                ? capped.map(m => `    - ${mcpUtils.wrapUntrustedValue(m.name)} (id: ${mcpUtils.wrapUntrustedValue(m.id)})`).join('\n')
                                : '    (no text models available)'
                            const overflow = textModels.length > MAX_MODELS_PER_PROVIDER
                                ? `\n    ... and ${textModels.length - MAX_MODELS_PER_PROVIDER} more${filterProvider ? '' : ` (use provider="${p.provider}" to see all)`}`
                                : ''
                            return `- ${mcpUtils.wrapUntrustedValue(p.name)} (${p.provider}, id: ${p.id}) — ${textModels.length} text model(s)\n  Models:\n${modelLines}${overflow}`
                        }
                        catch (err) {
                            log.warn({ err, provider: p.provider }, 'ap_list_ai_models: failed to fetch models for provider')
                            structuredProviders.push({ id: p.id, provider: p.provider, displayName: p.name, models: [] })
                            return `- ${mcpUtils.wrapUntrustedValue(p.name)} (${p.provider}, id: ${p.id})\n  (failed to fetch models)`
                        }
                    }),
                )

                // `providerId` is advertised again now that the AI qadam reads it and addresses
                // the config route by it. `provider` stays required alongside it — capability
                // decisions (web search, the OpenAI responses API) are keyed on the enum and cannot
                // consume a row id. Without the id, a name resolves to the platform's oldest row of
                // that type, which is the wrong one whenever two customs are configured.
                return {
                    content: [{
                        type: 'text',
                        text: `Configured AI Providers:\n\n${sections.join('\n\n')}\n\nUsage: Set aiProviderModel to {"providerId": "<provider row id>", "provider": "<provider>", "model": "<model id>"} when configuring a Run Agent step. Omitting providerId resolves the provider name to the platform's oldest row of that type.`,
                    }],
                    structuredContent: { providers: structuredProviders },
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_list_ai_models failed')
                return mcpUtils.mcpToolError('Failed to list AI models', err)
            }
        },
    }
}

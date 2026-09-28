import { AIProviderModel, AIProviderModelType, MistralProviderAuthConfig, MistralProviderConfig, parseModelContextWindowTokens, spreadIfDefined } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const mistralProvider: AIProviderStrategy<MistralProviderAuthConfig, MistralProviderConfig> = {
    name: 'Mistral AI',
    async validateConnection(authConfig: MistralProviderAuthConfig, config: MistralProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await mistralProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: MistralProviderAuthConfig, _config: MistralProviderConfig): Promise<AIProviderModel[]> {
        const { data } = await providerHttp.sendJson<{ data: MistralModel[] }>({
            url: 'https://api.mistral.ai/v1/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })

        return data
            .filter((model) => model.capabilities?.completion_chat)
            .map((model) => ({
                id: model.id,
                name: model.id,
                type: AIProviderModelType.TEXT,
                ...spreadIfDefined('contextWindowTokens', parseModelContextWindowTokens(model.max_context_length)),
            }))
    },
}

type MistralModel = {
    id: string
    // Optional on Mistral's `BaseModelCard`.
    max_context_length?: number
    capabilities?: {
        completion_chat: boolean
    }
}

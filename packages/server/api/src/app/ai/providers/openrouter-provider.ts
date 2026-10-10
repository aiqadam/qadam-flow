import { AIProviderModel, buildAIProviderModel, OpenRouterProviderAuthConfig, OpenRouterProviderConfig, parseModelContextWindowTokens } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const openRouterProvider: AIProviderStrategy<OpenRouterProviderAuthConfig, OpenRouterProviderConfig> = {
    name: 'OpenRouter',
    async validateConnection(authConfig: OpenRouterProviderAuthConfig, _config: OpenRouterProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await providerHttp.sendJson({
            url: 'https://openrouter.ai/api/v1/auth/key',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })
    },
    async listModels(_authConfig: OpenRouterProviderAuthConfig, _config: OpenRouterProviderConfig): Promise<AIProviderModel[]> {
        const { data } = await providerHttp.sendJson<{ data: OpenRouterModel[] }>({
            url: 'https://openrouter.ai/api/v1/models',
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        })

        return data.map((model: OpenRouterModel) => {
            const inputModalities = model.architecture?.input_modalities ?? []
            const outputModalities = model.architecture?.output_modalities ?? []
            return buildAIProviderModel({
                id: model.id,
                name: model.name,
                capabilities: {
                    inputModalities,
                    outputModalities,
                    // A model that answers in text can hold the chat; one that only draws an image
                    // (`output_modalities: ["image"]`) cannot.
                    chat: outputModalities.includes('text'),
                    tools: (model.supported_parameters ?? []).includes('tools'),
                },
                contextWindowTokens: parseModelContextWindowTokens(model.context_length),
            })
        })
    },
}

type OpenRouterModel = {
    id: string
    name: string
    // Required but nullable in OpenRouter's OpenAPI `Model` schema.
    context_length?: number | null
    architecture?: {
        input_modalities?: string[]
        output_modalities?: string[]
    }
    // What the model accepts in a request body; `tools` means function calling.
    supported_parameters?: string[]
}

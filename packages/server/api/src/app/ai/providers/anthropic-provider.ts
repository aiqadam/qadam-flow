import { AIProviderModel, AnthropicProviderAuthConfig, AnthropicProviderConfig, buildAIProviderModel } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const anthropicProvider: AIProviderStrategy<AnthropicProviderAuthConfig, AnthropicProviderConfig> = {
    name: 'Anthropic',
    async validateConnection(authConfig: AnthropicProviderAuthConfig, config: AnthropicProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await anthropicProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: AnthropicProviderAuthConfig, _config: AnthropicProviderConfig): Promise<AIProviderModel[]> {
        const { data } = await providerHttp.sendJson<{ data: AnthropicModel[] }>({
            url: 'https://api.anthropic.com/v1/models',
            method: 'GET',
            headers: {
                'x-api-key': authConfig.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
        })

        // Anthropic's catalogue is chat models only, and every one of them accepts images and calls
        // tools.
        return data.map((model: AnthropicModel) => buildAIProviderModel({
            id: model.id,
            name: model.display_name,
            capabilities: { inputModalities: ['text', 'image'], outputModalities: ['text'], chat: true, tools: true },
        }))
    },
}

type AnthropicModel = {
    id: string
    display_name: string
}

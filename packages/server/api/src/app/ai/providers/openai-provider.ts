import { AIProviderModel, AIProviderModelType, OpenAIProviderAuthConfig, OpenAIProviderConfig } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const openaiProvider: AIProviderStrategy<OpenAIProviderAuthConfig, OpenAIProviderConfig> = {
    name: 'OpenAI',
    async validateConnection(authConfig: OpenAIProviderAuthConfig, config: OpenAIProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await openaiProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: OpenAIProviderAuthConfig, _config: OpenAIProviderConfig): Promise<AIProviderModel[]> {
        const { data } = await providerHttp.sendJson<{ data: OpenAIModel[] }>({
            url: 'https://api.openai.com/v1/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })

        const openaiImageModels = [
            'gpt-image-1',
            'dall-e-3',
            'dall-e-2',
        ]

        return data.map((model: OpenAIModel) => ({
            id: model.id,
            name: model.id,
            type: openaiImageModels.includes(model.id) ? AIProviderModelType.IMAGE : AIProviderModelType.TEXT,
        }))
    },
}

type OpenAIModel = {
    id: string
}
import { AIProviderModel, buildAIProviderModel, GoogleProviderAuthConfig, GoogleProviderConfig, parseModelContextWindowTokens } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const googleProvider: AIProviderStrategy<GoogleProviderAuthConfig, GoogleProviderConfig> = {
    name: 'Google',
    async validateConnection(authConfig: GoogleProviderAuthConfig, config: GoogleProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await googleProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: GoogleProviderAuthConfig, _config: GoogleProviderConfig): Promise<AIProviderModel[]> {
        const body = await providerHttp.sendJson<{ models: GoogleModel[] }>({
            url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
            method: 'GET',
            headers: {
                'x-goog-api-key': authConfig.apiKey,
                'Content-Type': 'application/json',
            },
        })
        return body.models.map((model: GoogleModel) => {
            const id = stripModelsPrefix(model.name)
            // `supportedGenerationMethods` is the one capability signal Google's `Model` resource
            // carries: `generateContent` is a chat model, `embedContent` an embedding, `predict` an
            // image generator. Without it a model is offered to the chat and refused at request
            // time, which is exactly the stale-list failure this replaces.
            const methods = model.supportedGenerationMethods ?? []
            const chat = methods.includes('generateContent')
            const imageOutput = methods.includes('predict') || id.includes('image')
            return buildAIProviderModel({
                id,
                name: model.displayName,
                capabilities: {
                    // Google does not report input modalities; every chat model here accepts text,
                    // and the image generators take a text prompt.
                    inputModalities: ['text'],
                    outputModalities: googleOutputModalities({ chat, imageOutput }),
                    chat,
                    tools: chat,
                },
                contextWindowTokens: parseModelContextWindowTokens(model.inputTokenLimit),
            })
        })
    },
}

function googleOutputModalities({ chat, imageOutput }: { chat: boolean, imageOutput: boolean }): string[] {
    if (imageOutput) {
        return ['image']
    }
    return chat ? ['text'] : []
}

const GOOGLE_MODEL_PREFIX = 'models/'

function stripModelsPrefix(modelName: string): string {
    return modelName.startsWith(GOOGLE_MODEL_PREFIX) ? modelName.slice(GOOGLE_MODEL_PREFIX.length) : modelName
}

type GoogleModel = {
    name: string
    displayName: string
    // Not marked required on the `Model` resource, and proto3 JSON omits unset fields.
    inputTokenLimit?: number
    supportedGenerationMethods?: string[]
}

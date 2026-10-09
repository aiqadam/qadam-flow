import { AIProviderModel, AIProviderModelCapabilities, buildAIProviderModel, OpenAIProviderAuthConfig, OpenAIProviderConfig } from '@aiqadam/shared'
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

        return data.map((model: OpenAIModel) => buildAIProviderModel({
            id: model.id,
            name: model.id,
            capabilities: classifyOpenAIModel(model.id),
        }))
    },
}

// OpenAI's `/v1/models` reports an id and nothing else — no modality, no tool support, no
// generation method — so this is the one provider whose capabilities are inferred from the id.
// The default is "chat": a model OpenAI adds tomorrow is offered the day it appears, which is the
// whole point of dropping the old allow-list. Only the families that are provably not a chat model
// are carved out, and those names are stable.
function classifyOpenAIModel(id: string): AIProviderModelCapabilities {
    if (OPENAI_IMAGE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))) {
        return { inputModalities: ['text'], outputModalities: ['image'], chat: false, tools: false }
    }
    if (isOpenAINonChatModel(id)) {
        // Embeddings, speech, moderation and the legacy completion models. None output a tracked
        // modality and none can hold a conversation, so `outputModalities` stays empty.
        return { inputModalities: ['text'], outputModalities: [], chat: false, tools: false }
    }
    return { inputModalities: ['text'], outputModalities: ['text'], chat: true, tools: true }
}

// Prefixes cover the families whose names begin with the family; markers cover the ones OpenAI
// names as a suffix of a chat id (`gpt-4o-mini-tts`, `gpt-4o-transcribe`, `*-realtime-preview`),
// which a prefix match alone would miss and offer to the chat.
function isOpenAINonChatModel(id: string): boolean {
    if (OPENAI_NON_CHAT_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))) {
        return true
    }
    return OPENAI_NON_CHAT_MODEL_MARKERS.some((marker) => id.includes(marker))
}

const OPENAI_IMAGE_MODEL_PREFIXES = ['dall-e', 'gpt-image']
// `text-` covers the embedding, moderation, similarity and search families and the legacy
// completion models named `text-davinci-003` and friends; `davinci`/`babbage` cover their
// un-prefixed `-002` variants.
const OPENAI_NON_CHAT_MODEL_PREFIXES = [
    'text-',
    'whisper',
    'tts',
    'omni-moderation',
    'code-search',
    'davinci',
    'babbage',
    'gpt-3.5-turbo-instruct',
]
const OPENAI_NON_CHAT_MODEL_MARKERS = ['-tts', '-transcribe', '-realtime', 'whisper']

type OpenAIModel = {
    id: string
}

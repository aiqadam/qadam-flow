import { AIProviderModelType, AIProviderName } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The window size has to survive every layer between a provider's model list and the chat: the
// provider strategy, `aiProviderService.listModels` and its cache, then `chatModel.resolve`. Each
// layer had its own test with its neighbours mocked, and the service still dropped the field for
// every OpenRouter, Google and Mistral model, so the chat assumed 128k for all of them. Only the
// database and the outbound HTTP are stubbed here; the three layers are the real ones.
const { axiosRequest, findOneBy } = vi.hoisted(() => ({ axiosRequest: vi.fn(), findOneBy: vi.fn() }))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        safeHttp: { ...actual.safeHttp, axios: { request: axiosRequest } },
        chatAiUtils: { ...actual.chatAiUtils, createChatModel: () => 'language-model' },
    }
})
vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({ findOneBy }),
}))
vi.mock('../../../../src/app/helper/encryption', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/helper/encryption')>()
    return { ...actual, encryptUtils: { ...actual.encryptUtils, decryptObject: async () => ({ apiKey: 'test-key' }) } }
})

import { modelsCache } from '../../../../src/app/ai/models-cache'
import { chatModel } from '../../../../src/app/chat/chat-model'

const log = { error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

const OPENROUTER_MODELS = {
    data: [
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', context_length: 163_840, architecture: { output_modalities: ['text'] } },
        { id: 'some/model', name: 'Unknown', context_length: null, architecture: { output_modalities: ['text'] } },
    ],
}

function providerRow({ provider, config }: { provider: AIProviderName, config: Record<string, unknown> }) {
    return { id: 'provider-row-id', platformId: 'plat', provider, config, auth: {}, enabledForChat: true, updated: '2026-09-29T00:00:00.000Z' }
}

beforeEach(() => {
    vi.clearAllMocks()
    modelsCache.clear()
    axiosRequest.mockResolvedValue({ status: 200, statusText: 'OK', data: OPENROUTER_MODELS, headers: {} })
})

describe('context window from the provider model list to the chat', () => {
    it('gives the chat the OpenRouter window of the model the conversation picked', async () => {
        findOneBy.mockResolvedValue(providerRow({ provider: AIProviderName.OPENROUTER, config: {} }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'deepseek/deepseek-chat', log })

        expect(resolved.contextWindowTokens).toBe(163_840)
    })

    it('gives the chat the OpenRouter window when no model was picked', async () => {
        findOneBy.mockResolvedValue(providerRow({ provider: AIProviderName.OPENROUTER, config: {} }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.modelId).toBe('deepseek/deepseek-chat')
        expect(resolved.contextWindowTokens).toBe(163_840)
    })

    it('keeps the window on a model list served from the cache', async () => {
        findOneBy.mockResolvedValue(providerRow({ provider: AIProviderName.OPENROUTER, config: {} }))

        await chatModel.resolve({ platformId: 'plat', modelName: 'deepseek/deepseek-chat', log })
        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'deepseek/deepseek-chat', log })

        expect(axiosRequest).toHaveBeenCalledTimes(1)
        expect(resolved.contextWindowTokens).toBe(163_840)
    })

    it('leaves the window unknown for a model the provider reports no size for', async () => {
        findOneBy.mockResolvedValue(providerRow({ provider: AIProviderName.OPENROUTER, config: {} }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'some/model', log })

        expect(resolved.contextWindowTokens).toBeNull()
    })

    it('gives the chat the operator-set window of a picked CUSTOM model', async () => {
        findOneBy.mockResolvedValue(providerRow({
            provider: AIProviderName.CUSTOM,
            config: {
                baseUrl: 'https://llm.internal/v1',
                apiKeyHeader: 'Authorization',
                models: [
                    { modelId: 'first', modelName: 'First', modelType: AIProviderModelType.TEXT },
                    { modelId: 'picked', modelName: 'Picked', modelType: AIProviderModelType.TEXT, contextWindowTokens: 65_536 },
                ],
            },
        }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'picked', log })

        expect(resolved.contextWindowTokens).toBe(65_536)
        expect(axiosRequest).not.toHaveBeenCalled()
    })
})

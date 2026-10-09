import { AIProviderModelType } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same stub as google-provider.test.ts: the SSRF-filtered client, not an unfiltered one.
const { axiosRequest } = vi.hoisted(() => ({ axiosRequest: vi.fn() }))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        safeHttp: { ...actual.safeHttp, axios: { request: axiosRequest } },
    }
})

import { cloudflareGatewayProvider } from '../../../../../src/app/ai/providers/cloudflare-gateway-provider'
import { googleProvider } from '../../../../../src/app/ai/providers/google-provider'
import { mistralProvider } from '../../../../../src/app/ai/providers/mistral-provider'
import { openAICompatibleProvider } from '../../../../../src/app/ai/providers/openai-compatible-gateway-provider'
import { openRouterProvider } from '../../../../../src/app/ai/providers/openrouter-provider'

function respondWith(data: unknown): void {
    axiosRequest.mockResolvedValue({ status: 200, statusText: 'OK', data, headers: {} })
}

describe('context window sizes in provider model lists', () => {
    beforeEach(() => {
        axiosRequest.mockReset()
    })

    it('reads OpenRouter context_length, and treats its documented null as not reported', async () => {
        respondWith({
            data: [
                { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', context_length: 200_000, architecture: { output_modalities: ['text'] } },
                { id: 'some/model', name: 'Unknown', context_length: null, architecture: { output_modalities: ['text'] } },
            ],
        })

        const models = await openRouterProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models).toEqual([
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', type: AIProviderModelType.TEXT, capabilities: { inputModalities: [], outputModalities: ['text'], chat: true, tools: false }, contextWindowTokens: 200_000 },
            { id: 'some/model', name: 'Unknown', type: AIProviderModelType.TEXT, capabilities: { inputModalities: [], outputModalities: ['text'], chat: true, tools: false } },
        ])
    })

    it('reads Google inputTokenLimit, and leaves a model without one unsized', async () => {
        respondWith({
            models: [
                { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1_048_576 },
                { name: 'models/gemini-legacy', displayName: 'Legacy' },
            ],
        })

        const models = await googleProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models.map((model) => model.contextWindowTokens)).toEqual([1_048_576, undefined])
        expect(models[1]).not.toHaveProperty('contextWindowTokens')
    })

    it('reads Mistral max_context_length', async () => {
        respondWith({
            data: [{ id: 'mistral-large-latest', max_context_length: 131_072, capabilities: { completion_chat: true } }],
        })

        const models = await mistralProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models[0]?.contextWindowTokens).toBe(131_072)
    })

    it('drops a reported size no operator could have entered', async () => {
        respondWith({
            data: [{ id: 'weird/model', name: 'Weird', context_length: 0.5, architecture: { output_modalities: ['text'] } }],
        })

        const models = await openRouterProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models[0]).not.toHaveProperty('contextWindowTokens')
    })

    it('passes through the size the operator entered on a CUSTOM or Cloudflare Gateway catalogue', async () => {
        const models = [
            { modelId: 'qwen3-32b', modelName: 'Qwen3 32B', modelType: AIProviderModelType.TEXT, contextWindowTokens: 32_768 },
            { modelId: 'llama', modelName: 'Llama', modelType: AIProviderModelType.TEXT },
        ]

        const custom = await openAICompatibleProvider.listModels({ apiKey: 'k' }, { apiKeyHeader: 'Authorization', baseUrl: 'https://vllm.internal/v1', models })
        const gateway = await cloudflareGatewayProvider.listModels({ apiKey: 'k' }, { accountId: 'a', gatewayId: 'g', models })

        for (const listed of [custom, gateway]) {
            expect(listed[0]?.contextWindowTokens).toBe(32_768)
            expect(listed[1]).not.toHaveProperty('contextWindowTokens')
        }
    })
})

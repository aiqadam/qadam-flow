import { AIProviderName } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'
import { chatAiUtils } from '../src/chat-ai-utils'
import { safeHttp } from '../src/safe-http'

// Each provider factory is mocked purely to capture the options it was constructed with. Without
// this, deleting `fetch: safeHttp.fetch` from any single branch of `createChatModel` leaves the
// whole suite green — the wrapper's own tests say nothing about whether anything uses it.
const captured = new Map<string, Record<string, unknown>>()

function captureFactory(key: string) {
    return (options: Record<string, unknown>) => {
        captured.set(key, options)
        const model = () => 'model'
        model.chat = () => 'model'
        model.chatModel = () => 'model'
        return model
    }
}

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: captureFactory('openai') }))
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: captureFactory('anthropic') }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: captureFactory('google') }))
vi.mock('@ai-sdk/azure', () => ({ createAzure: captureFactory('azure') }))
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: captureFactory('bedrock') }))
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: captureFactory('openai-compatible') }))
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: captureFactory('openrouter') }))

const CASES: Array<{ provider: AIProviderName, factory: string, config: Record<string, unknown> }> = [
    { provider: AIProviderName.OPENAI, factory: 'openai', config: {} },
    { provider: AIProviderName.ANTHROPIC, factory: 'anthropic', config: {} },
    { provider: AIProviderName.GOOGLE, factory: 'google', config: {} },
    { provider: AIProviderName.AZURE, factory: 'azure', config: { resourceName: 'res' } },
    { provider: AIProviderName.BEDROCK, factory: 'bedrock', config: { region: 'us-east-1' } },
    { provider: AIProviderName.CLOUDFLARE_GATEWAY, factory: 'openai-compatible', config: { accountId: 'acc', gatewayId: 'gw' } },
    { provider: AIProviderName.CUSTOM, factory: 'openai-compatible', config: { baseUrl: 'https://llm.internal/v1', apiKeyHeader: 'Authorization', models: [] } },
    { provider: AIProviderName.MISTRAL, factory: 'openrouter', config: {} },
    { provider: AIProviderName.OPENROUTER, factory: 'openrouter', config: {} },
]

describe('createChatModel SSRF wiring', () => {
    it.each(CASES)('routes $provider through the filtered client', ({ provider, factory, config }) => {
        captured.clear()

        chatAiUtils.createChatModel({
            provider,
            auth: { apiKey: 'k', accessKeyId: 'a', secretAccessKey: 's' },
            config,
            modelId: 'openai/gpt-4o',
        })

        expect(captured.get(factory)?.['fetch']).toBe(safeHttp.fetch)
    })

    // Guards the enumeration above against a provider being added to the enum and quietly shipping
    // on the unfiltered global fetch.
    it('covers every provider the enum declares', () => {
        expect(new Set(CASES.map((testCase) => testCase.provider))).toEqual(new Set(Object.values(AIProviderName)))
    })
})

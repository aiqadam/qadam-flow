import { AIProviderName, INVALID_AWS_REGION_MESSAGE, INVALID_AZURE_RESOURCE_NAME_MESSAGE } from '@aiqadam/shared'
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

// safeHttp.fetch filters the address the host resolves to, not which host was named — an
// attacker-chosen public host passes it. The row is read from the database and never re-parsed
// against `AzureProviderConfig`, so a `resourceName` stored before that constraint existed has to
// be refused here or it still builds the request host (#276).
describe('createChatModel rejects a stored config value that would move the host', () => {
    it.each([
        ['attacker.example.com/'],
        ['attacker.example.com@resource'],
        ['my.resource'],
        [''],
    ])('refuses to construct the provider for %j', (resourceName) => {
        captured.clear()

        expect(() => chatAiUtils.createChatModel({
            provider: AIProviderName.AZURE,
            auth: { apiKey: 'k' },
            config: { resourceName },
            modelId: 'gpt-4o',
        })).toThrow(INVALID_AZURE_RESOURCE_NAME_MESSAGE)

        expect(captured.has('azure')).toBe(false)
    })

    // `@aws-sdk/client-bedrock` resolves `region` into the endpoint host the same way — `evil.com/`
    // gives host `bedrock.evil.com` — and it is read from the same never-re-parsed row.
    it.each([
        ['evil.com/'],
        ['x@evil.com'],
        ['us-east-1.evil.com'],
        [''],
    ])('refuses to construct the bedrock provider for a region of %j', (region) => {
        captured.clear()

        expect(() => chatAiUtils.createChatModel({
            provider: AIProviderName.BEDROCK,
            auth: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
            config: { region },
            modelId: 'anthropic.claude-sonnet-4',
        })).toThrow(INVALID_AWS_REGION_MESSAGE)

        expect(captured.has('bedrock')).toBe(false)
    })
})

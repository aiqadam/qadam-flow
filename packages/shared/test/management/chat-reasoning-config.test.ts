import { formErrors } from '../../src/lib/form-errors'
import {
    AIProviderConfig,
    AIProviderName,
    CHAT_REASONING_PROVIDERS,
    ChatReasoningConfig,
    CreateAIProviderRequest,
    MAX_CHAT_REASONING_BUDGET_TOKENS,
    MIN_CHAT_REASONING_BUDGET_TOKENS,
    parseProviderConfig,
    UpdateAIProviderRequest,
} from '../../src/lib/management/ai-providers'

// #566. The budget is the one number here a provider can refuse a whole turn over, so its bounds
// are pinned at both edges, and so is the message: it is an i18n key the provider form renders.
describe('ChatReasoningConfig.budgetTokens', () => {
    it.each([
        ['the minimum', MIN_CHAT_REASONING_BUDGET_TOKENS],
        ['the maximum', MAX_CHAT_REASONING_BUDGET_TOKENS],
        ['a value between', 8_000],
    ])('accepts %s', (_label, budgetTokens) => {
        expect(ChatReasoningConfig.safeParse({ enabled: true, budgetTokens }).success).toBe(true)
    })

    it.each([
        ['one below the minimum', MIN_CHAT_REASONING_BUDGET_TOKENS - 1],
        ['one above the maximum', MAX_CHAT_REASONING_BUDGET_TOKENS + 1],
        ['a fraction', 4_096.5],
        ['zero', 0],
        ['a negative number', -2_048],
    ])('rejects %s with the translated message', (_label, budgetTokens) => {
        const result = ChatReasoningConfig.safeParse({ enabled: true, budgetTokens })

        expect(result.success).toBe(false)
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([formErrors.reasoningBudgetTokensOutOfRange])
    })

    // An `enabled: false` row still carries its budget, so turning it back on restores the value the
    // admin chose rather than resetting it — which means the budget is validated either way.
    it('validates the budget of a disabled setting too', () => {
        expect(ChatReasoningConfig.safeParse({ enabled: false, budgetTokens: 10 }).success).toBe(false)
    })
})

describe('where the reasoning setting is accepted', () => {
    const reasoning = { enabled: true, budgetTokens: 4_096 }

    it.each([
        [AIProviderName.ANTHROPIC, {}],
        [AIProviderName.GOOGLE, {}],
        [AIProviderName.OPENROUTER, {}],
        [AIProviderName.BEDROCK, { region: 'us-east-1' }],
    ])('is kept on a %s config', (provider, config) => {
        expect(parseProviderConfig({ provider, config: { ...config, reasoning } })).toEqual({ ...config, reasoning })
    })

    it('is offered for exactly the four providers that chat can ask to reason', () => {
        expect([...CHAT_REASONING_PROVIDERS].sort()).toEqual([AIProviderName.ANTHROPIC, AIProviderName.BEDROCK, AIProviderName.GOOGLE, AIProviderName.OPENROUTER].sort())
    })

    it.each([AIProviderName.OPENAI, AIProviderName.MISTRAL])('is refused on a %s config', (provider) => {
        expect(parseProviderConfig({ provider, config: { reasoning } })).toBeNull()
        expect(CreateAIProviderRequest.safeParse({ provider, displayName: 'x', auth: { apiKey: 'k' }, config: { reasoning } }).success).toBe(false)
    })

    it.each([
        [AIProviderName.AZURE, { resourceName: 'my-resource' }],
        [AIProviderName.CUSTOM, { apiKeyHeader: 'Authorization', baseUrl: 'https://llm.internal/v1', models: [] }],
        [AIProviderName.CLOUDFLARE_GATEWAY, { accountId: 'a', gatewayId: 'g', models: [] }],
    ])('is not stored on a %s config', (provider, config) => {
        expect(parseProviderConfig({ provider, config: { ...config, reasoning } })).not.toHaveProperty('reasoning')
    })

    it('is kept by the create request of a provider that supports it', () => {
        const parsed = CreateAIProviderRequest.parse({ provider: AIProviderName.ANTHROPIC, displayName: 'Anthropic', auth: { apiKey: 'k' }, config: { reasoning } })

        expect(parsed.config).toEqual({ reasoning })
    })
})

// The update body's `config` is the untagged union, which ends in empty objects. A bad budget must
// fail the request, not fall through to an empty member and parse to `{}` — which the service would
// then save, silently wiping the row's setting.
describe('an update carrying an out-of-range budget', () => {
    it.each([
        ['an Anthropic-shaped config', {}],
        ['a Bedrock-shaped config', { region: 'us-east-1' }],
    ])('is refused for %s rather than parsed to a config without it', (_label, config) => {
        const body = { config: { ...config, reasoning: { enabled: true, budgetTokens: 100 } } }

        expect(UpdateAIProviderRequest.safeParse(body).success).toBe(false)
        expect(AIProviderConfig.safeParse(body.config).success).toBe(false)
    })

    it('still parses a valid setting through the union with the setting intact', () => {
        const config = { reasoning: { enabled: true, budgetTokens: 2_048 } }

        expect(UpdateAIProviderRequest.parse({ config }).config).toEqual(config)
    })
})

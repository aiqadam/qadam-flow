import { AIProviderName } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { chatAiUtils } from '../src/chat-ai-utils'

// #566. Each shape below is the key and value the installed SDK reads, not a guess at one: an
// option under the wrong key is dropped by the SDK without a word, which is exactly how the
// pre-#566 helper sent Bedrock `{ anthropic: { thinking } }` and would have asked for nothing.
const ON = { enabled: true, budgetTokens: 4_096 }

describe('chatAiUtils.buildProviderOptions', () => {
    describe('asks for nothing unless the row opted in', () => {
        it.each([
            ['absent', undefined],
            ['disabled', { enabled: false, budgetTokens: 4_096 }],
            ['malformed', { enabled: 'yes', budgetTokens: 4_096 }],
            ['out of range', { enabled: true, budgetTokens: 100 }],
            ['not an object', 'on'],
        ])('returns null when the setting is %s', (_label, reasoning) => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId: 'claude-sonnet-4-5', reasoning })).toBeNull()
        })

        it.each([
            AIProviderName.OPENAI,
            AIProviderName.AZURE,
            AIProviderName.CUSTOM,
            AIProviderName.CLOUDFLARE_GATEWAY,
            AIProviderName.MISTRAL,
        ])('returns null for %s, which is out of scope, even with the setting on', (provider) => {
            expect(chatAiUtils.buildProviderOptions({ provider, modelId: 'model', reasoning: ON })).toBeNull()
        })
    })

    describe('Anthropic', () => {
        it.each([
            'claude-sonnet-4-5-20250929',
            'claude-haiku-4-5',
            'claude-opus-4-5-20251101',
            'claude-opus-4-1-20250805',
            'claude-sonnet-4-20250514',
            'claude-opus-4-0',
            'claude-3-7-sonnet-latest',
        ])('sends a fixed budget to %s, which rejects adaptive thinking', (modelId) => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId, reasoning: ON })).toEqual({
                anthropic: { thinking: { type: 'enabled', budgetTokens: 4_096 } },
            })
        })

        it.each([
            'claude-sonnet-4-6',
            'claude-opus-4-6',
            'claude-opus-4-7',
            'claude-opus-5-5',
            'a-model-nobody-has-heard-of',
        ])('sends adaptive thinking with its summary shown to %s', (modelId) => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId, reasoning: ON })).toEqual({
                anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
            })
        })
    })

    describe('Bedrock', () => {
        it('uses the bedrock key and reasoningConfig, which is what @ai-sdk/amazon-bedrock reads', () => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.BEDROCK, modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', reasoning: ON })).toEqual({
                bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 4_096 } },
            })
        })

        it('sends adaptive thinking to a newer Claude on Bedrock', () => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.BEDROCK, modelId: 'global.anthropic.claude-opus-4-7-v1', reasoning: ON })).toEqual({
                bedrock: { reasoningConfig: { type: 'adaptive', display: 'summarized' } },
            })
        })

        it('asks nothing of a Bedrock model that is not Claude', () => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.BEDROCK, modelId: 'amazon.nova-pro-v1:0', reasoning: ON })).toBeNull()
        })
    })

    it('asks OpenRouter through its reasoning parameter alone, with no prompt caching riding along', () => {
        expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.OPENROUTER, modelId: 'anthropic/claude-sonnet-4.5', reasoning: ON })).toEqual({
            openrouter: { reasoning: { max_tokens: 4_096 } },
        })
    })

    it('asks Gemini to include its thoughts, and sends no budget', () => {
        expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.GOOGLE, modelId: 'gemini-2.5-flash', reasoning: ON })).toEqual({
            google: { thinkingConfig: { includeThoughts: true } },
        })
    })
})

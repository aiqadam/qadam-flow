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

    // Claude before 3.7 cannot think, and answers 400 to either shape. A Bedrock row lists every
    // active Claude with no allow-list in front, so these are reachable ids, not hypotheticals.
    describe('Claude models that cannot think are asked nothing', () => {
        it.each([
            'claude-3-5-haiku-20241022',
            'claude-3-5-sonnet-latest',
            'claude-3-haiku-20240307',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-2.1',
            'claude-2.0',
            'claude-instant-1.2',
        ])('on Anthropic: %s', (modelId) => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId, reasoning: ON })).toBeNull()
        })

        it.each([
            'anthropic.claude-3-haiku-20240307-v1:0',
            'anthropic.claude-3-5-sonnet-20241022-v2:0',
            'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            'eu.anthropic.claude-3-sonnet-20240229-v1:0',
            'apac.anthropic.claude-3-opus-20240229-v1:0',
            'anthropic.claude-v2',
            'anthropic.claude-v2:1',
            'anthropic.claude-instant-v1',
        ])('on Bedrock: %s', (modelId) => {
            expect(chatAiUtils.buildProviderOptions({ provider: AIProviderName.BEDROCK, modelId, reasoning: ON })).toBeNull()
        })

        // The exclusion must not swallow the first Claude that can think, in either id form.
        it.each([
            [AIProviderName.ANTHROPIC, 'claude-3-7-sonnet-20250219'],
            [AIProviderName.BEDROCK, 'us.anthropic.claude-3-7-sonnet-20250219-v1:0'],
        ])('still asks %s %s for a budget', (provider, modelId) => {
            expect(chatAiUtils.buildProviderOptions({ provider, modelId, reasoning: ON })).not.toBeNull()
        })

        // Linear-time check on a hostile id: a pattern with nested quantifiers would take seconds
        // here, these take well under one.
        it('matches a long adversarial id quickly', () => {
            const hostile = `${'claude-3-'.repeat(20_000)}7`
            const started = performance.now()
            chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId: hostile, reasoning: ON })
            chatAiUtils.buildProviderOptions({ provider: AIProviderName.ANTHROPIC, modelId: `${'claude-sonnet-4-'.repeat(20_000)}x`, reasoning: ON })
            expect(performance.now() - started).toBeLessThan(500)
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

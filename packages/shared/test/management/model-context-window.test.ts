import { describe, expect, it } from 'vitest'
import {
    AIProviderModelType,
    formErrors,
    MAX_MODEL_CONTEXT_WINDOW_TOKENS,
    MIN_MODEL_CONTEXT_WINDOW_TOKENS,
    parseModelContextWindowTokens,
    ProviderModelConfig,
} from '../../src'

const textModel = { modelId: 'qwen3-32b', modelName: 'Qwen3 32B', modelType: AIProviderModelType.TEXT }

describe('ProviderModelConfig.contextWindowTokens', () => {
    it('is optional, so every catalogue saved before it existed still parses', () => {
        expect(ProviderModelConfig.safeParse(textModel).success).toBe(true)
    })

    it('keeps a size the operator entered', () => {
        expect(ProviderModelConfig.parse({ ...textModel, contextWindowTokens: 32_768 }).contextWindowTokens).toBe(32_768)
    })

    it.each([
        ['a fraction', 32_768.5],
        ['a size below the minimum', MIN_MODEL_CONTEXT_WINDOW_TOKENS - 1],
        ['a size above the maximum', MAX_MODEL_CONTEXT_WINDOW_TOKENS + 1],
    ])('rejects %s with the translated message', (_label, contextWindowTokens) => {
        const result = ProviderModelConfig.safeParse({ ...textModel, contextWindowTokens })

        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.message).toBe(formErrors.contextWindowTokensOutOfRange)
    })
})

describe('parseModelContextWindowTokens', () => {
    it('keeps a size a provider reported', () => {
        expect(parseModelContextWindowTokens(1_048_576)).toBe(1_048_576)
    })

    it.each([
        ['null', null],
        ['absent', undefined],
        ['a string', '128000'],
        ['zero', 0],
        ['a negative number', -1],
        ['infinity', Number.POSITIVE_INFINITY],
    ])('reads %s as not reported', (_label, value) => {
        expect(parseModelContextWindowTokens(value)).toBeUndefined()
    })
})

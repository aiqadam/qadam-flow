import { formErrors } from '../../src/lib/form-errors'
import { mergeOpenAICompatibleExtraBody, OpenAICompatibleProviderConfig } from '../../src/lib/management/ai-providers'

const BASE_CONFIG = {
    baseUrl: 'https://vllm.internal/v1',
    apiKeyHeader: 'Authorization',
    models: [],
}

function issueMessages(extraBody: unknown): string[] {
    const parsed = OpenAICompatibleProviderConfig.safeParse({ ...BASE_CONFIG, extraBody })
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('OpenAICompatibleProviderConfig.extraBody', () => {
    it('accepts the Qwen non-thinking parameters vLLM documents', () => {
        const extraBody = { chat_template_kwargs: { enable_thinking: false }, top_k: 20, presence_penalty: 1.5 }

        const parsed = OpenAICompatibleProviderConfig.parse({ ...BASE_CONFIG, extraBody })

        expect(parsed.extraBody).toEqual(extraBody)
    })

    it('stays optional, so every row stored before the field existed still parses', () => {
        expect(OpenAICompatibleProviderConfig.safeParse(BASE_CONFIG).success).toBe(true)
    })

    it.each(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'response_format'])(
        'rejects the SDK-owned key %s with a translatable message',
        (key) => {
            expect(issueMessages({ [key]: 'x' })).toEqual([formErrors.extraBodyReservedKey])
        },
    )

    it.each([['an array', []], ['a string', '{"top_k": 20}'], ['a number', 1]])(
        'rejects %s with a translatable message',
        (_label, extraBody) => {
            expect(issueMessages(extraBody)).toEqual([formErrors.extraBodyMustBeObject])
        },
    )

    it('rejects a body too large to merge into every request', () => {
        expect(issueMessages({ padding: 'x'.repeat(9000) })).toEqual([formErrors.extraBodyTooLarge])
    })
})

describe('mergeOpenAICompatibleExtraBody', () => {
    const body = { model: 'Qwen/Qwen3.8-27B', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }

    it('returns the body untouched when the row has no extraBody', () => {
        expect(mergeOpenAICompatibleExtraBody({ body, extraBody: undefined })).toBe(body)
    })

    it('adds the configured parameters and lets them override sampling defaults', () => {
        const merged = mergeOpenAICompatibleExtraBody({
            body,
            extraBody: { chat_template_kwargs: { enable_thinking: false }, temperature: 0.7 },
        })

        expect(merged).toEqual({ ...body, chat_template_kwargs: { enable_thinking: false }, temperature: 0.7 })
    })

    // The qadam reads the row back as an unchecked cast, so a stored value that never went through
    // the refine must still not be able to re-point the model or replace the conversation.
    it('drops reserved keys even when they reach it unvalidated', () => {
        const merged = mergeOpenAICompatibleExtraBody({
            body,
            extraBody: { model: 'attacker/model', messages: [], top_k: 20 },
        })

        expect(merged).toEqual({ ...body, top_k: 20 })
    })
})

/**
 * DoD 3 of #265: the classifier must map a transport failure to a message that tells the user
 * what to change. Each pattern is pinned to the exact message the transport produces — safe-http
 * (`the provider stopped sending data for Xs mid-response`), axios (`timeout of Nms exceeded`),
 * and the SSRF filter enrichment — so a renamed transport message fails here first.
 */
import { describe, expect, it } from 'vitest'
import { CHAT_ERROR_CODES, classifyChatError } from '../../../../src/app/chat/chat-error-classify'

describe('classifyChatError (#265 DoD 3)', () => {
    it('classifies the inter-chunk idle timeout', () => {
        const { code, message } = classifyChatError(new Error('the provider stopped sending data for 120s mid-response'))
        expect(code).toBe(CHAT_ERROR_CODES.PROVIDER_IDLE_TIMEOUT)
        expect(message).toContain('AP_HTTP_STREAM_IDLE_TIMEOUT_SECONDS')
    })

    it('classifies the first-byte timeout', () => {
        const { code, message } = classifyChatError(new Error('timeout of 300000ms exceeded'))
        expect(code).toBe(CHAT_ERROR_CODES.PROVIDER_FIRST_BYTE_TIMEOUT)
        expect(message).toContain('AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS')
        expect(message).toContain('local or self-hosted')
    })

    it('classifies the SSRF-filter block', () => {
        const { code, message } = classifyChatError(new Error('request to http://169.254.169.254 failed, the target is blocked by the SSRF filter'))
        expect(code).toBe(CHAT_ERROR_CODES.PROVIDER_SSRF_BLOCKED)
        expect(message).toContain('AP_SSRF_ALLOW_LIST')
    })

    // Each message below is what the provider (or the SDK wrapping its transport) actually says,
    // so the classes stay pinned to real wording rather than to the regexes that match it.
    it.each([
        ['Ollama without tool support', 'registry.ollama.ai/library/gemma:2b does not support tools', CHAT_ERROR_CODES.PROVIDER_TOOLS_NOT_SUPPORTED],
        ['vLLM without auto tool choice', '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set', CHAT_ERROR_CODES.PROVIDER_TOOLS_NOT_SUPPORTED],
        ['an OpenAI-style context overflow', 'This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.', CHAT_ERROR_CODES.PROVIDER_CONTEXT_LENGTH_EXCEEDED],
        ['an Ollama model that was never pulled', 'model "llama3" not found, try pulling it first', CHAT_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND],
        ['a refused connection to a local model', 'Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434', CHAT_ERROR_CODES.PROVIDER_UNREACHABLE],
        ['a host that does not resolve', 'getaddrinfo ENOTFOUND ollama', CHAT_ERROR_CODES.PROVIDER_UNREACHABLE],
        ['a rejected key', 'Incorrect API key provided: sk-abc***', CHAT_ERROR_CODES.PROVIDER_AUTH_FAILED],
    ])('classifies %s', (_label, message, expected) => {
        expect(classifyChatError(new Error(message)).code).toBe(expected)
    })

    it.each([
        [401, CHAT_ERROR_CODES.PROVIDER_AUTH_FAILED],
        [403, CHAT_ERROR_CODES.PROVIDER_AUTH_FAILED],
        [404, CHAT_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND],
        [429, CHAT_ERROR_CODES.PROVIDER_RATE_LIMITED],
    ])('classifies an HTTP %i from the provider by its status alone', (statusCode, expected) => {
        expect(classifyChatError({ name: 'AI_APICallError', message: 'Bad things', statusCode }).code).toBe(expected)
    })

    // What the SDK throws once it has used up its retries: the status is on `lastError`, not on the
    // error the loop receives.
    it('reads the status through a RetryError', () => {
        const retryError = { name: 'AI_RetryError', message: 'Failed after 3 attempts. Last error: Service said no', lastError: { statusCode: 429 } }
        expect(classifyChatError(retryError).code).toBe(CHAT_ERROR_CODES.PROVIDER_RATE_LIMITED)
    })

    it('lets the SSRF block win over the generic connection class it arrives wrapped in', () => {
        const { code } = classifyChatError(new Error('Cannot connect to API: IP 10.0.0.5 is not allowed — the target is blocked by the SSRF filter.'))
        expect(code).toBe(CHAT_ERROR_CODES.PROVIDER_SSRF_BLOCKED)
    })

    it('tells a Docker operator about host.docker.internal when the provider is unreachable', () => {
        const { message } = classifyChatError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))
        expect(message).toContain('host.docker.internal')
    })

    // The wrapper `result.steps` rejects with when the first step failed. It carries no cause of
    // its own, which is why the loop must classify the error `onError` captured instead.
    it('cannot classify the NoOutputGeneratedError wrapper on its own', () => {
        const { code } = classifyChatError({ name: 'AI_NoOutputGeneratedError', message: 'No output generated. Check the stream for errors.' })
        expect(code).toBe(CHAT_ERROR_CODES.UNKNOWN)
    })

    it('keeps the generic message for anything else, with the UNKNOWN code', () => {
        const { code, message } = classifyChatError(new Error('provider exploded'))
        expect(code).toBe(CHAT_ERROR_CODES.UNKNOWN)
        expect(message).toBe('The assistant could not finish this message. Please try again.')
    })

    it('degrades gracefully for non-Error input and never touches the error object', () => {
        const { code } = classifyChatError('a string')
        expect(code).toBe(CHAT_ERROR_CODES.UNKNOWN)
        const { code: code2 } = classifyChatError({ name: 'APICallError', requestBodyValues: { apiKey: 'secret' } })
        expect(code2).toBe(CHAT_ERROR_CODES.UNKNOWN)
    })
})

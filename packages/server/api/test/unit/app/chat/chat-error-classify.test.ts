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

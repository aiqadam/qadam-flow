import { describe, expect, it } from 'vitest'
import { otelRedaction } from '../../src/otel-redaction'

const TOKEN = '123456789:AAHhk-this-is-the-secret'

describe('otelRedaction', () => {
    // instrumentation-undici sets url.full, url.path and url.query two lines apart, and
    // instrumentation-http sets http.target — redacting only the full URL leaves the token exported.
    it('covers every attribute the HTTP instrumentations record a URL path under', () => {
        expect(otelRedaction.urlAttributes).toEqual(
            expect.arrayContaining(['url.full', 'url.path', 'http.url', 'http.target']),
        )
    })

    it('redacts the token from a full URL', () => {
        const redacted = otelRedaction.redactCredentialsInUrl(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=50`)

        expect(redacted).not.toContain(TOKEN)
        expect(redacted).toBe('https://api.telegram.org/bot[REDACTED]/getUpdates?timeout=50')
    })

    it('redacts the token from a bare path, which is what url.path and http.target carry', () => {
        const redacted = otelRedaction.redactCredentialsInUrl(`/bot${TOKEN}/sendMessage`)

        expect(redacted).not.toContain(TOKEN)
        expect(redacted).toBe('/bot[REDACTED]/sendMessage')
    })

    it('leaves a URL with no credential alone', () => {
        expect(otelRedaction.redactCredentialsInUrl('https://api.example.com/v1/things?page=2')).toBe(
            'https://api.example.com/v1/things?page=2',
        )
    })
})

import { SSRFBlockedError } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryingFetch, RetryPolicy } from '../src/lib/retrying-fetch'

const FAST: RetryPolicy = { budgetMs: 1_000, initialDelayMs: 5, maxDelayMs: 20 }
const URL_WITH_TOKEN = 'http://app/v1/files/f1?token=secret-engine-token'

describe('retryingFetch', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('retries a refused connection for a non-idempotent request too: the app never saw it', async () => {
        const fetchSpy = failThenSucceed({ failures: 2, failure: () => fetchFailed({ code: 'ECONNREFUSED' }) })

        const response = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'POST' }, idempotent: false, policy: FAST })

        expect(response.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledTimes(3)
    })

    it('finds the code on a happy-eyeballs AggregateError', async () => {
        const aggregate = new AggregateError([
            Object.assign(new Error('connect ECONNREFUSED ::1:80'), { code: 'ECONNREFUSED' }),
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' }),
        ])
        const fetchSpy = failThenSucceed({ failures: 1, failure: () => new TypeError('fetch failed', { cause: aggregate }) })

        await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: false, policy: FAST })

        expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('replays a reset connection only for an idempotent request', async () => {
        const reset = (): Error => fetchFailed({ code: 'ECONNRESET' })
        const idempotent = failThenSucceed({ failures: 1, failure: reset })
        await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true, policy: FAST })
        expect(idempotent).toHaveBeenCalledTimes(2)
        vi.restoreAllMocks()

        const nonIdempotent = failThenSucceed({ failures: 1, failure: reset })
        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'POST' }, idempotent: false, policy: FAST })).rejects.toThrow('fetch failed')
        expect(nonIdempotent).toHaveBeenCalledTimes(1)
    })

    it('returns a 503 to a non-idempotent caller at once, since the app may have acted on it', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }))

        const response = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'POST' }, idempotent: false, policy: FAST })

        expect(response.status).toBe(503)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('never retries an SSRF block, so the guard fails as fast as it did', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed', {
            cause: new SSRFBlockedError({ host: 'app', ip: '169.254.169.254' }),
        }))

        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: FAST })).rejects.toThrow('fetch failed')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('never retries an error with no socket code, such as an abort', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'))

        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: FAST })).rejects.toThrow('aborted')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('returns the last 5xx once the budget is spent, and logs the give-up without the token', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('down', { status: 502 }))

        const response = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true, policy: { ...FAST, budgetMs: 100 } })

        expect(response.status).toBe(502)
        expect(warn).toHaveBeenCalledTimes(1)
        const line = String(warn.mock.calls[0][0])
        expect(line).toContain('PUT /v1/files/f1')
        expect(line).not.toContain('secret-engine-token')
    })

    it('stops waiting between attempts as soon as the caller aborts', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(fetchFailed({ code: 'ECONNREFUSED' }))
        const caller = new AbortController()
        setTimeout(() => caller.abort(new Error('caller gave up')), 50)

        const startedAt = Date.now()
        const result = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { signal: caller.signal }, idempotent: true, policy: { budgetMs: 10_000, initialDelayMs: 2_000, maxDelayMs: 2_000 } })

        await expect(result).rejects.toThrow('caller gave up')
        expect(Date.now() - startedAt).toBeLessThan(1_000)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('passes a caller abort during an attempt straight through, as the caller\'s own error', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => rejectWhenAborted(init?.signal))
        const caller = new AbortController()
        setTimeout(() => caller.abort(new Error('caller gave up')), 20)

        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { signal: caller.signal }, idempotent: true, policy: FAST })).rejects.toThrow('caller gave up')
    })

    it('bounds an attempt that never answers by the full default budget, on fake time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => rejectWhenAborted(init?.signal))
        const startedAt = performance.now()

        const outcome = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true }).then(() => 'resolved', (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(60_000)
        const error = await outcome
        vi.useRealTimers()

        expect(error instanceof DOMException ? error.name : error).toBe('TimeoutError')
        expect(performance.now() - startedAt).toBeLessThanOrEqual(60_000)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
})

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
}

function fetchFailed({ code }: { code: string }): Error {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
}

function failThenSucceed({ failures, failure }: { failures: number, failure: () => Error }) {
    let remaining = failures
    return vi.spyOn(global, 'fetch').mockImplementation(async () => {
        if (remaining > 0) {
            remaining -= 1
            throw failure()
        }
        return new Response('ok', { status: 200 })
    })
}

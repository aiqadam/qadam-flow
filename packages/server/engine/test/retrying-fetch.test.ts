import { SSRFBlockedError } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryingFetch, RetryPolicy } from '../src/lib/retrying-fetch'

const FAST: RetryPolicy = { budgetMs: 1_000, attemptTimeoutMs: 1_000, initialDelayMs: 5, maxDelayMs: 20 }
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
        const result = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { signal: caller.signal }, idempotent: true, policy: { budgetMs: 10_000, attemptTimeoutMs: 10_000, initialDelayMs: 2_000, maxDelayMs: 2_000 } })

        await expect(result).rejects.toThrow('caller gave up')
        expect(Date.now() - startedAt).toBeLessThan(1_000)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('releases a held 5xx body when the caller aborts during the backoff', async () => {
        const cancel = vi.fn()
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }))
        const caller = new AbortController()
        setTimeout(() => caller.abort(new Error('caller gave up')), 50)

        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { signal: caller.signal }, idempotent: true, policy: { budgetMs: 10_000, attemptTimeoutMs: 10_000, initialDelayMs: 2_000, maxDelayMs: 2_000 } })).rejects.toThrow('caller gave up')
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('passes a caller abort during an attempt straight through, as the caller\'s own error', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => rejectWhenAborted(init?.signal))
        const caller = new AbortController()
        setTimeout(() => caller.abort(new Error('caller gave up')), 20)

        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { signal: caller.signal }, idempotent: true, policy: FAST })).rejects.toThrow('caller gave up')
    })

    // A healthy request that is merely slow (headers come only after the app has the whole body)
    // must not be cut short by the retry budget: only the attempt timeout bounds a first attempt.
    it.each([
        ['default', retryingFetch.defaultPolicy, 75_000],
        ['best-effort', retryingFetch.bestEffortPolicy, 12_000],
    ])('lets a healthy first attempt that answers after the %s budget succeed, on fake time', async (_name, policy, answerAfterMs) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        expect(answerAfterMs).toBeGreaterThan(policy.budgetMs)
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => answerAfter({ ms: answerAfterMs, signal: init?.signal }))

        const outcome = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: false, policy }).then((r) => r.status, (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(answerAfterMs + 1)

        expect(await outcome).toBe(200)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('bounds a first attempt that never answers by the 300 s attempt timeout and logs it as a timeout, on fake time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => rejectWhenAborted(init?.signal))
        const startedAt = performance.now()

        const outcome = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true }).then(() => 'resolved', (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(299_999)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(2)
        const error = await outcome

        expect(retryingFetch.defaultPolicy.attemptTimeoutMs).toBe(300_000)
        expect(error instanceof DOMException ? error.name : error).toBe('TimeoutError')
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(300_000)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const line = String(warn.mock.calls[0]?.[0])
        expect(line).toContain('no answer within 300000 ms on attempt 1')
        expect(line).not.toContain('still failing')
    })

    // Every attempt gets the full attempt timeout, a retry included: the budget only decides whether
    // one starts. So one call can last about budget + attemptTimeoutMs, never longer.
    it('bounds a retry that never answers by the attempt timeout, not by the budget left, on fake time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        let calls = 0
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            calls += 1
            if (calls === 1) {
                throw fetchFailed({ code: 'ECONNREFUSED' })
            }
            return rejectWhenAborted(init?.signal)
        })
        const startedAt = performance.now()

        let settledAt = Number.NaN
        const outcome = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true }).then(() => 'resolved', (e: unknown) => {
            settledAt = performance.now()
            return e
        })
        await vi.advanceTimersByTimeAsync(301_000)
        const error = await outcome

        expect(error instanceof DOMException ? error.name : error).toBe('TimeoutError')
        const elapsed = settledAt - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(300_000)
        expect(elapsed).toBeLessThanOrEqual(retryingFetch.defaultPolicy.budgetMs + retryingFetch.defaultPolicy.attemptTimeoutMs)
        expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    // The #595 scenario with a large body: the app is back late in the budget, and the run-log
    // upload that follows takes longer than what is left of it.
    it('lets a slow but healthy retry late in the budget succeed, on fake time', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        const backAt = performance.now() + 50_000
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
            if (performance.now() < backAt) {
                throw fetchFailed({ code: 'ECONNREFUSED' })
            }
            return answerAfter({ ms: 30_000, signal: init?.signal })
        })

        const outcome = retryingFetch.fetch({ url: URL_WITH_TOKEN, init: { method: 'PUT' }, idempotent: true }).then((r) => r.status, (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(90_000)

        expect(await outcome).toBe(200)
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    })

    it('gives up with the last real error when the backoff sleep overran the budget', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
            // A busy event loop: the backoff timer fires long after it was due.
            setImmediate(() => blockEventLoop(200))
            throw fetchFailed({ code: 'ECONNREFUSED' })
        })

        const error = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: { ...FAST, budgetMs: 100 } }).catch((e: unknown) => e)

        expect(String(error)).toContain('fetch failed')
        expect(error).not.toBeInstanceOf(DOMException)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    // Timers fire late. The last backoff is clamped to end just inside the budget, so a late timer
    // must still lead to that final attempt, or an app that comes back in the last seconds is missed.
    it('still makes the final attempt when the clamped last sleep fires late, but within the budget', async () => {
        let calls = 0
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
            calls += 1
            if (calls === 1) {
                // The backoff is clamped to end at 250 ms, 50 ms before the budget. Busy from 240 ms to
                // ~270 ms, the loop fires it ~20 ms late: past the window, still inside the budget.
                setTimeout(() => blockEventLoop(30), 240)
                throw fetchFailed({ code: 'ECONNREFUSED' })
            }
            return new Response('ok', { status: 200 })
        })

        const response = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: { budgetMs: 300, attemptTimeoutMs: 1_000, initialDelayMs: 5_000, maxDelayMs: 5_000 } })

        expect(response.status).toBe(200)
        expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('treats a zero budget as no retries, not as no time to answer', async () => {
        const refused = vi.spyOn(global, 'fetch').mockRejectedValue(fetchFailed({ code: 'ECONNREFUSED' }))
        await expect(retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: { ...FAST, budgetMs: 0 } })).rejects.toThrow('fetch failed')
        expect(refused).toHaveBeenCalledTimes(1)
        vi.restoreAllMocks()

        vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => answerAfter({ ms: 50, signal: init?.signal }))
        const response = await retryingFetch.fetch({ url: URL_WITH_TOKEN, init: {}, idempotent: true, policy: { ...FAST, budgetMs: 0 } })
        expect(response.status).toBe(200)
    })
})

function answerAfter({ ms, signal }: { ms: number, signal: AbortSignal | null | undefined }): Promise<Response> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('ok', { status: 200 })), ms)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason)
        }, { once: true })
    })
}

function blockEventLoop(ms: number): void {
    const until = Date.now() + ms
    while (Date.now() < until) {
        // spin
    }
}

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

import { singleFlightTtlCache } from '../../../../src/app/qadams/census/framework-census-cache'

// #838: `GET /v1/framework-census` walks every flow of a platform once a context version is
// retired. The cache bounds that to one walk per platform per TTL, shared by concurrent requests,
// and bounds how long anyone waits on one walk.
describe('singleFlightTtlCache (#838)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('shares one computation between concurrent callers for the same key', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        const pending = deferred<string>()
        const compute = vi.fn(() => pending.promise)

        const first = cache.get({ key: 'platform-a', compute })
        const second = cache.get({ key: 'platform-a', compute })
        pending.resolve('census')

        expect(await first).toBe('census')
        expect(await second).toBe('census')
        expect(compute).toHaveBeenCalledTimes(1)
    })

    it('serves a settled value until the TTL runs out, then computes again', async () => {
        const cache = singleFlightTtlCache.create<number>({ ttlMs: 1000 })
        let calls = 0
        const compute = vi.fn(async () => ++calls)

        expect(await cache.get({ key: 'platform-a', compute })).toBe(1)
        vi.advanceTimersByTime(999)
        expect(await cache.get({ key: 'platform-a', compute })).toBe(1)
        vi.advanceTimersByTime(1)
        expect(await cache.get({ key: 'platform-a', compute })).toBe(2)
        expect(compute).toHaveBeenCalledTimes(2)
    })

    it('starts the TTL when the value settles, not when the computation starts', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, maxInFlightMs: 10_000 })
        const pending = deferred<string>()
        const compute = vi.fn(() => pending.promise)

        const first = cache.get({ key: 'platform-a', compute })
        vi.advanceTimersByTime(5000)
        pending.resolve('slow census')
        await first
        vi.advanceTimersByTime(999)

        expect(await cache.get({ key: 'platform-a', compute })).toBe('slow census')
        expect(compute).toHaveBeenCalledTimes(1)
    })

    it('never caches a failure', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        const compute = vi.fn()
            .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
            .mockResolvedValueOnce('census')

        await expect(cache.get({ key: 'platform-a', compute })).rejects.toThrow('Connection terminated unexpectedly')
        expect(await cache.get({ key: 'platform-a', compute })).toBe('census')
        expect(compute).toHaveBeenCalledTimes(2)
    })

    it('shares a rejection between concurrent callers, then computes again', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        const pending = deferred<string>()
        const compute = vi.fn(() => pending.promise)

        const first = cache.get({ key: 'platform-a', compute })
        const second = cache.get({ key: 'platform-a', compute })
        pending.reject(new Error('Connection terminated unexpectedly'))

        await expect(first).rejects.toThrow('Connection terminated unexpectedly')
        await expect(second).rejects.toThrow('Connection terminated unexpectedly')
        expect(compute).toHaveBeenCalledTimes(1)
        expect(await cache.get({ key: 'platform-a', compute: async () => 'census' })).toBe('census')
    })

    // A walk that hangs (a stuck connection) must not hold its waiters, or answer for its platform,
    // past the bound.
    it('releases every waiter at maxInFlightMs, including one that joined late, evicts the entry and reports it once', async () => {
        const onAbandon = vi.fn()
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, maxInFlightMs: 2000, onAbandon })
        const hung = deferred<string>()
        const first = cache.get({ key: 'platform-a', compute: () => hung.promise })
        const firstSettled = expect(first).rejects.toThrow('Abandoned after 2000 ms in flight')

        vi.advanceTimersByTime(1999)
        const joinedLate = vi.fn(async () => 'not computed')
        const late = cache.get({ key: 'platform-a', compute: joinedLate })
        const lateSettled = expect(late).rejects.toThrow('Abandoned after 2000 ms in flight')
        expect(joinedLate).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        await firstSettled
        await lateSettled
        expect(onAbandon).toHaveBeenCalledTimes(1)
        expect(onAbandon).toHaveBeenCalledWith({ key: 'platform-a', maxInFlightMs: 2000 })

        expect(await cache.get({ key: 'platform-a', compute: async () => 'fresh census' })).toBe('fresh census')

        // The abandoned walk settling late displaces nothing.
        hung.resolve('late census')
        await vi.advanceTimersByTimeAsync(0)
        expect(await cache.get({ key: 'platform-a', compute: async () => 'another census' })).toBe('fresh census')
    })

    it('defaults maxInFlightMs to twice the TTL', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        const waiting = cache.get({ key: 'platform-a', compute: () => deferred<string>().promise })
        const settled = expect(waiting).rejects.toThrow('Abandoned after 2000 ms in flight')

        await vi.advanceTimersByTimeAsync(2000)

        await settled
    })

    it('ignores an old computation that settles after clear(), whether it resolves or rejects', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        const resolvesLate = deferred<string>()
        const rejectsLate = deferred<string>()
        const first = cache.get({ key: 'platform-a', compute: () => resolvesLate.promise })
        const second = cache.get({ key: 'platform-b', compute: () => rejectsLate.promise })
        const secondSettled = expect(second).rejects.toThrow('late failure')

        cache.clear()
        expect(await cache.get({ key: 'platform-a', compute: async () => 'fresh a' })).toBe('fresh a')
        expect(await cache.get({ key: 'platform-b', compute: async () => 'fresh b' })).toBe('fresh b')

        resolvesLate.resolve('old a')
        rejectsLate.reject(new Error('late failure'))
        expect(await first).toBe('old a')
        await secondSettled

        const compute = vi.fn(async () => 'not computed')
        expect(await cache.get({ key: 'platform-a', compute })).toBe('fresh a')
        expect(await cache.get({ key: 'platform-b', compute })).toBe('fresh b')
        expect(compute).not.toHaveBeenCalled()
    })

    it('keeps keys apart', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })

        expect(await cache.get({ key: 'platform-a', compute: async () => 'a' })).toBe('a')
        expect(await cache.get({ key: 'platform-b', compute: async () => 'b' })).toBe('b')
        expect(await cache.get({ key: 'platform-a', compute: async () => 'not a' })).toBe('a')
    })

    it('forgets everything on clear', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000 })
        await cache.get({ key: 'platform-a', compute: async () => 'old' })

        cache.clear()

        expect(await cache.get({ key: 'platform-a', compute: async () => 'new' })).toBe('new')
    })
})

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void } {
    let resolve: (value: T) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const promise = new Promise<T>((settle, fail) => {
        resolve = settle
        reject = fail
    })
    return { promise, resolve, reject }
}

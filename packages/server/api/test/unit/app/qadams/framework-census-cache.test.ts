import { singleFlightTtlCache } from '../../../../src/app/qadams/census/framework-census-cache'

// #838: `GET /v1/framework-census` walks every flow of a platform once a context version is
// retired. The cache bounds that to one walk per platform per TTL, shared by concurrent requests.
describe('singleFlightTtlCache (#838)', () => {
    it('shares one computation between concurrent callers for the same key', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })
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
        let time = 0
        const cache = singleFlightTtlCache.create<number>({ ttlMs: 1000, now: () => time })
        let calls = 0
        const compute = vi.fn(async () => ++calls)

        expect(await cache.get({ key: 'platform-a', compute })).toBe(1)
        time = 999
        expect(await cache.get({ key: 'platform-a', compute })).toBe(1)
        time = 1000
        expect(await cache.get({ key: 'platform-a', compute })).toBe(2)
        expect(compute).toHaveBeenCalledTimes(2)
    })

    it('starts the TTL when the value settles, not when the computation starts', async () => {
        let time = 0
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => time })
        const pending = deferred<string>()
        const compute = vi.fn(() => pending.promise)

        const first = cache.get({ key: 'platform-a', compute })
        time = 5000
        pending.resolve('slow census')
        await first
        time = 5999

        expect(await cache.get({ key: 'platform-a', compute })).toBe('slow census')
        expect(compute).toHaveBeenCalledTimes(1)
    })

    it('never caches a failure', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })
        const compute = vi.fn()
            .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
            .mockResolvedValueOnce('census')

        await expect(cache.get({ key: 'platform-a', compute })).rejects.toThrow('Connection terminated unexpectedly')
        expect(await cache.get({ key: 'platform-a', compute })).toBe('census')
        expect(compute).toHaveBeenCalledTimes(2)
    })

    it('shares a rejection between concurrent callers, then computes again', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })
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

    // A walk that hangs (a stuck connection) must not answer for its platform until a restart.
    it('replaces a computation still in flight after maxInFlightMs', async () => {
        let time = 0
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, maxInFlightMs: 2000, now: () => time })
        const hung = deferred<string>()
        void cache.get({ key: 'platform-a', compute: () => hung.promise })

        time = 1999
        const stillShared = vi.fn(async () => 'not yet')
        const waiting = cache.get({ key: 'platform-a', compute: stillShared })
        expect(stillShared).not.toHaveBeenCalled()

        time = 2000
        expect(await cache.get({ key: 'platform-a', compute: async () => 'fresh census' })).toBe('fresh census')

        // The hung walk settling late does not displace the fresh value.
        hung.resolve('late census')
        expect(await waiting).toBe('late census')
        expect(await cache.get({ key: 'platform-a', compute: async () => 'another census' })).toBe('fresh census')
    })

    it('defaults maxInFlightMs to twice the TTL', async () => {
        let time = 0
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => time })
        void cache.get({ key: 'platform-a', compute: () => deferred<string>().promise })

        time = 1999
        const shared = vi.fn(async () => 'shared')
        void cache.get({ key: 'platform-a', compute: shared })
        expect(shared).not.toHaveBeenCalled()

        time = 2000
        expect(await cache.get({ key: 'platform-a', compute: async () => 'fresh' })).toBe('fresh')
    })

    it('computes again after clear() during a computation, and the old one settling does not come back', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })
        const old = deferred<string>()
        const first = cache.get({ key: 'platform-a', compute: () => old.promise })

        cache.clear()
        const second = cache.get({ key: 'platform-a', compute: async () => 'new' })
        old.resolve('old')

        expect(await first).toBe('old')
        expect(await second).toBe('new')
        expect(await cache.get({ key: 'platform-a', compute: async () => 'newer' })).toBe('new')
    })

    it('keeps keys apart', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })

        expect(await cache.get({ key: 'platform-a', compute: async () => 'a' })).toBe('a')
        expect(await cache.get({ key: 'platform-b', compute: async () => 'b' })).toBe('b')
        expect(await cache.get({ key: 'platform-a', compute: async () => 'not a' })).toBe('a')
    })

    it('forgets everything on clear', async () => {
        const cache = singleFlightTtlCache.create<string>({ ttlMs: 1000, now: () => 0 })
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

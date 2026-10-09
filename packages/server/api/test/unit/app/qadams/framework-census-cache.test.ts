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

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

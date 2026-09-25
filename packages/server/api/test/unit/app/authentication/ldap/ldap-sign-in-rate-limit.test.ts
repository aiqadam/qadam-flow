import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ldapSignInRateLimit } from '../../../../../src/app/authentication/ldap/ldap-sign-in-rate-limit'

// A minimal fake standing in for the one ioredis surface this file touches: `multi().incr(key)
// .expire(key, seconds, 'NX').exec()`. Real atomicity (no other client's command landing between
// the INCR and the EXPIRE) is a property of Redis's own MULTI/EXEC, not something a unit test can
// observe — what this file can and does check is that `assertNotRateLimited` issues exactly that
// batched shape, keeps two independently-keyed counters, and applies the same normalisation to
// both of them and to nothing else.
type FakeRedis = {
    counters: Map<string, number>
    multi: () => FakeMulti
}

type FakeMulti = {
    incr: (key: string) => FakeMulti
    expire: (key: string, seconds: number, flag: string) => FakeMulti
    exec: () => Promise<[Error | null, number][]>
}

function createFakeRedis(): FakeRedis {
    const counters = new Map<string, number>()
    return {
        counters,
        multi(): FakeMulti {
            const pendingIncrKeys: string[] = []
            const chain: FakeMulti = {
                incr(key: string) {
                    pendingIncrKeys.push(key)
                    return chain
                },
                expire() {
                    return chain
                },
                async exec() {
                    return pendingIncrKeys.map((key) => {
                        const next = (counters.get(key) ?? 0) + 1
                        counters.set(key, next)
                        return [null, next]
                    })
                },
            }
            return chain
        },
    }
}

const fakeRedis = { current: createFakeRedis() }

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    redisConnections: {
        useExisting: async () => fakeRedis.current,
    },
}))

beforeEach(() => {
    fakeRedis.current = createFakeRedis()
})

describe('ldapSignInRateLimit.assertNotRateLimited', () => {
    it('allows attempts under both the per-IP and per-username limits', async () => {
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe' })).resolves.toBeUndefined()
    })

    it('rejects once the per-IP-and-username bucket is exceeded', async () => {
        for (let i = 0; i < 10; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe' })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe' })).rejects.toThrow()
    })

    it('rejects once the per-username bucket is exceeded, even from many different IPs', async () => {
        for (let i = 0; i < 30; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: `10.0.0.${i}`, username: 'jdoe' })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '10.0.0.99', username: 'jdoe' })).rejects.toThrow()
    })

    it('treats a Unicode-equivalent username as the same bucket (cannot dodge the per-username limit)', async () => {
        for (let i = 0; i < 30; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: `10.0.1.${i}`, username: 'JDoe' })
        }
        // Fullwidth "jdoe", NFKC-folds to the same normalized value as the 30 attempts above.
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '10.0.1.200', username: 'ｊｄｏｅ' })).rejects.toThrow()
    })

    it('keeps separate buckets per platform', async () => {
        for (let i = 0; i < 10; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe' })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p2', ip: '1.1.1.1', username: 'jdoe' })).resolves.toBeUndefined()
    })
})

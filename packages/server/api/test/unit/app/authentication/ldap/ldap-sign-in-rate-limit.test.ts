import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ldapSignInRateLimit } from '../../../../../src/app/authentication/ldap/ldap-sign-in-rate-limit'

// A minimal fake standing in for the one ioredis surface this file touches: `multi().set(key, 0,
// 'EX', seconds, 'NX').incr(key).exec()`. Real atomicity (no other client's command landing
// between the SET and the INCR) is a property of Redis's own MULTI/EXEC, not something a unit test
// can observe — what this file can and does check is that `assertNotRateLimited` issues exactly
// that batched shape (compatible with Redis >= 2.6.12, unlike `EXPIRE ... NX` which needs Redis 7),
// keeps two independently-keyed counters, applies the same normalisation to both of them and to
// nothing else, and refuses (rather than 500s) when the MULTI/EXEC itself fails.
type FakeRedis = {
    counters: Map<string, number>
    multi: () => FakeMulti
}

type FakeMulti = {
    set: (key: string, value: number, exFlag: string, seconds: number, nxFlag: string) => FakeMulti
    incr: (key: string) => FakeMulti
    exec: () => Promise<[Error | null, number][] | null>
}

function createFakeRedis(): FakeRedis {
    const counters = new Map<string, number>()
    return {
        counters,
        multi(): FakeMulti {
            // Real redis MULTI/EXEC returns one reply per queued command, in order — `set` first,
            // `incr` second — so the fake must too, or `incrementWithExpiry`'s own `results[1]`
            // reads the wrong (or a missing) reply.
            const queuedCommands: (() => [Error | null, number])[] = []
            const chain: FakeMulti = {
                set(key: string) {
                    queuedCommands.push(() => {
                        if (!counters.has(key)) {
                            counters.set(key, 0)
                        }
                        return [null, 0]
                    })
                    return chain
                },
                incr(key: string) {
                    queuedCommands.push(() => {
                        const next = (counters.get(key) ?? 0) + 1
                        counters.set(key, next)
                        return [null, next]
                    })
                    return chain
                },
                async exec() {
                    return queuedCommands.map((run) => run())
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

const log = pino({ level: 'silent' })

beforeEach(() => {
    fakeRedis.current = createFakeRedis()
    vi.clearAllMocks()
})

describe('ldapSignInRateLimit.assertNotRateLimited', () => {
    it('allows attempts under both the per-IP and per-username limits', async () => {
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe', log })).resolves.toBeUndefined()
    })

    it('rejects once the per-IP-and-username bucket is exceeded', async () => {
        for (let i = 0; i < 10; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe', log })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe', log })).rejects.toThrow()
    })

    it('rejects once the per-username bucket is exceeded, even from many different IPs', async () => {
        for (let i = 0; i < 30; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: `10.0.0.${i}`, username: 'jdoe', log })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '10.0.0.99', username: 'jdoe', log })).rejects.toThrow()
    })

    it('treats a Unicode-equivalent username as the same bucket (cannot dodge the per-username limit)', async () => {
        for (let i = 0; i < 30; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: `10.0.1.${i}`, username: 'JDoe', log })
        }
        // Fullwidth "jdoe", NFKC-folds to the same normalized value as the 30 attempts above.
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '10.0.1.200', username: 'ｊｄｏｅ', log })).rejects.toThrow()
    })

    it('keeps separate buckets per platform', async () => {
        for (let i = 0; i < 10; i++) {
            await ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe', log })
        }
        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p2', ip: '1.1.1.1', username: 'jdoe', log })).resolves.toBeUndefined()
    })

    it('refuses the sign-in attempt (rather than throwing an unhandled 500) and logs an error when the Redis MULTI/EXEC itself fails', async () => {
        const errorSpy = vi.spyOn(log, 'error')
        fakeRedis.current.multi = (): FakeMulti => {
            const brokenChain: FakeMulti = {
                set: () => brokenChain,
                incr: () => brokenChain,
                exec: () => {
                    throw new Error('simulated Redis connection failure')
                },
            }
            return brokenChain
        }

        await expect(ldapSignInRateLimit.assertNotRateLimited({ platformId: 'p1', ip: '1.1.1.1', username: 'jdoe', log })).rejects.toThrow()
        expect(errorSpy).toHaveBeenCalled()
    })
})

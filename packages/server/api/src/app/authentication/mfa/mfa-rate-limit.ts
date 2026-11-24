import { ErrorCode, isNil, QadamFlowError, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { redisConnections } from '../../database/redis-connections'

// Same fixed-window, Redis-backed approach as the LDAP sign-in limiter (`.agents/features/ldap.md`):
// one bucket per identity (the botnet-proof dimension, since it ignores source IP) and one per IP
// (shared across identities). Counters are incremented before the code is checked, so a burst of
// wrong guesses is bounded regardless of how many of them happen to be right.
const MAX_ATTEMPTS_PER_IDENTITY = 10
const MAX_ATTEMPTS_PER_IP = 30
const WINDOW_SECONDS = 60

export const mfaRateLimit = {
    assertNotRateLimited,
}

async function assertNotRateLimited({ identityId, ip, log }: AssertNotRateLimitedParams): Promise<void> {
    const redis = await redisConnections.useExisting()
    const result = await tryCatch(() => Promise.all([
        incrementWithExpiry({ redis, key: `mfa-challenge:id:${identityId}` }),
        incrementWithExpiry({ redis, key: `mfa-challenge:ip:${ip}` }),
    ]))
    if (!isNil(result.error)) {
        // Fail closed, like the LDAP limiter: a Redis outage must not remove the brute-force bound.
        log.error({ err: result.error, identityId }, '[mfaRateLimit] Redis rate-limit check failed; refusing the attempt')
        throw new QadamFlowError({ code: ErrorCode.MFA_TOO_MANY_ATTEMPTS, params: {} })
    }
    const [perIdentity, perIp] = result.data
    if (perIdentity > MAX_ATTEMPTS_PER_IDENTITY || perIp > MAX_ATTEMPTS_PER_IP) {
        throw new QadamFlowError({ code: ErrorCode.MFA_TOO_MANY_ATTEMPTS, params: {} })
    }
}

// `SET ... NX` + `INCR` in one MULTI: equivalent back to Redis 2.6.12 and atomic, so a brand-new
// key can never be incremented once before it has a TTL.
async function incrementWithExpiry({ redis, key }: IncrementWithExpiryParams): Promise<number> {
    const results = await redis
        .multi()
        .set(key, 0, 'EX', WINDOW_SECONDS, 'NX')
        .incr(key)
        .exec()
    if (isNil(results)) {
        throw new Error('MFA rate-limit MULTI was aborted before EXEC ran')
    }
    for (const [commandError] of results) {
        if (!isNil(commandError)) {
            throw commandError
        }
    }
    const [, incrResult] = results[1]
    return Number(incrResult)
}

type AssertNotRateLimitedParams = {
    identityId: string
    ip: string
    log: FastifyBaseLogger
}

type IncrementWithExpiryParams = {
    redis: Awaited<ReturnType<typeof redisConnections.useExisting>>
    key: string
}

import { ErrorCode, isNil, QadamFlowError } from '@aiqadam/shared'
import { redisConnections } from '../../database/redis-connections'
import { ldapUsernameUtils } from './ldap-username'

// The per-IP limit on this route comes from the same `@fastify/rate-limit` registration every
// other `/v1/authn/*` route opts into (`AP_API_RATE_LIMIT_AUTHN_MAX`/`_WINDOW`) — see
// `ldap-authn-controller.ts`'s route config. That plugin supports exactly one bucket per route,
// so this file owns two more small fixed-window counters of its own, in the same Redis the rest of
// the process already uses:
//   - `platformId:ip:username` — caps attempts against one *username* from one *IP*.
//   - `platformId:username`    — caps attempts against one *username* regardless of which IP they
//     arrive from, which the per-IP bucket above cannot do for a botnet spread across many source
//     addresses. Both buckets use the same normalised username (`ldapUsernameUtils.normalize`) —
//     the same normalisation `ldap-authn-service.ts` applies before the directory search — so a
//     Unicode-equivalent spelling of a username can neither dodge the limit nor land in a
//     different bucket than the sign-in attempt it is rate-limiting actually resolves to.
const MAX_ATTEMPTS_PER_IP_AND_USERNAME = 10
const MAX_ATTEMPTS_PER_USERNAME = 30
const WINDOW_SECONDS = 60

async function assertNotRateLimited({ platformId, ip, username }: AssertNotRateLimitedParams): Promise<void> {
    const normalizedUsername = ldapUsernameUtils.normalize(username)
    const redis = await redisConnections.useExisting()
    const [perIpCount, perUsernameCount] = await Promise.all([
        incrementWithExpiry({ redis, key: `ldap-sign-in:${platformId}:${ip}:${normalizedUsername}` }),
        incrementWithExpiry({ redis, key: `ldap-sign-in:${platformId}:${normalizedUsername}` }),
    ])
    if (perIpCount > MAX_ATTEMPTS_PER_IP_AND_USERNAME || perUsernameCount > MAX_ATTEMPTS_PER_USERNAME) {
        throw new QadamFlowError({
            code: ErrorCode.INVALID_CREDENTIALS,
            params: null,
        })
    }
}

// `INCR` then a conditional `EXPIRE` (the previous shape) has a window between the two commands
// where a concurrent request can `INCR` the same brand-new key before it has a TTL — that request's
// own `count === 1` check then sees a wrong count and sets an *extra* `EXPIRE`, which is harmless by
// itself, but the sequence is not what "one atomic operation" means, and the extension point (a
// future caller reading the key between the two commands) is not something the previous shape
// closes. `MULTI` batches both commands into one round trip Redis executes without interleaving
// any other client's command in between.
async function incrementWithExpiry({ redis, key }: IncrementWithExpiryParams): Promise<number> {
    const results = await redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS, 'NX')
        .exec()
    const [incrError, count] = results?.[0] ?? [new Error('LDAP rate-limit MULTI returned no result'), 0]
    if (!isNil(incrError)) {
        throw incrError
    }
    return Number(count)
}

export const ldapSignInRateLimit = {
    assertNotRateLimited,
}

type AssertNotRateLimitedParams = {
    platformId: string
    ip: string
    username: string
}

type IncrementWithExpiryParams = {
    redis: Awaited<ReturnType<typeof redisConnections.useExisting>>
    key: string
}

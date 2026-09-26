import { ErrorCode, isNil, QadamFlowError, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { redisConnections } from '../../database/redis-connections'
import { ldapUsernameUtils } from './ldap-username'

export const ldapSignInRateLimit = {
    assertNotRateLimited,
}

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
//
// Accepted risk: the per-username bucket (below) is keyed on the username alone, regardless of
// source IP — deliberately, since that is the one dimension the per-IP bucket cannot cover for a
// botnet. That same property means a single attacker who merely *knows* (or guesses) a valid
// username can lock out every legitimate sign-in attempt for that username, from any IP, for the
// rest of the window — a denial-of-service against one account rather than a credential-stuffing
// defense against many. This is the accepted trade for closing the botnet gap; the per-IP bucket
// still bounds how much of that one attacker's own traffic counts towards it.
const MAX_ATTEMPTS_PER_IP_AND_USERNAME = 10
const MAX_ATTEMPTS_PER_USERNAME = 30
const WINDOW_SECONDS = 60

async function assertNotRateLimited({ platformId, ip, username, log }: AssertNotRateLimitedParams): Promise<void> {
    const normalizedUsername = ldapUsernameUtils.normalize(username)
    const redis = await redisConnections.useExisting()
    const result = await tryCatch(() => Promise.all([
        incrementWithExpiry({ redis, key: `ldap-sign-in:${platformId}:${ip}:${normalizedUsername}` }),
        incrementWithExpiry({ redis, key: `ldap-sign-in:${platformId}:${normalizedUsername}` }),
    ]))
    if (result.error !== null) {
        // Fail closed, not open: a Redis error here must refuse the sign-in attempt rather than
        // let it through with no rate limit at all, and must not surface as an unhandled 500 —
        // both of which the previous shape (an uncaught throw from inside the `Promise.all`) risked.
        log.error({ err: result.error, platformId }, '[ldapSignInRateLimit] Redis rate-limit check failed; refusing the sign-in attempt rather than allowing it unlimited')
        throw new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
    }
    const [perIpCount, perUsernameCount] = result.data
    if (perIpCount > MAX_ATTEMPTS_PER_IP_AND_USERNAME || perUsernameCount > MAX_ATTEMPTS_PER_USERNAME) {
        throw new QadamFlowError({
            code: ErrorCode.INVALID_CREDENTIALS,
            params: null,
        })
    }
}

// `EXPIRE ... NX` (the previous shape) requires Redis 7 — this process may run against an older
// server. `SET key 0 EX <ttl> NX` followed by `INCR key`, both in one `MULTI`, is equivalent back
// to Redis 2.6.12: `SET ... NX` only takes effect the first time this key is seen in the window
// (a later `SET` in the same window is a no-op, since the key already exists), and `INCR` always
// runs — whether it just created the counter or is incrementing an existing one — with the same
// one-round-trip atomicity `MULTI`/`EXEC` gives the pair, closing the same window a plain
// `INCR`-then-conditional-`EXPIRE` would reopen (a concurrent request `INCR`-ing the same brand-new
// key before it has a TTL).
async function incrementWithExpiry({ redis, key }: IncrementWithExpiryParams): Promise<number> {
    const results = await redis
        .multi()
        .set(key, 0, 'EX', WINDOW_SECONDS, 'NX')
        .incr(key)
        .exec()
    if (isNil(results)) {
        throw new Error('LDAP rate-limit MULTI was aborted (a watched key changed) before EXEC ran')
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
    platformId: string
    ip: string
    username: string
    log: FastifyBaseLogger
}

type IncrementWithExpiryParams = {
    redis: Awaited<ReturnType<typeof redisConnections.useExisting>>
    key: string
}

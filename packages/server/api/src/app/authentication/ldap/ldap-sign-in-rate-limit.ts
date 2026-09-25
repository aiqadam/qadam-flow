import { ErrorCode, QadamFlowError } from '@aiqadam/shared'
import { redisConnections } from '../../database/redis-connections'

// The per-IP limit on this route comes from the same `@fastify/rate-limit` registration every
// other `/v1/authn/*` route opts into (`AP_API_RATE_LIMIT_AUTHN_MAX`/`_WINDOW`) — see
// `ldap-authn-controller.ts`'s route config. That plugin supports exactly one bucket per route,
// so the second dimension this endpoint needs — capping attempts against one *username*
// regardless of which IP they arrive from, which a per-IP-only limit cannot do for a botnet spread
// across many source addresses — is a small fixed-window counter of its own, keyed on
// `platformId:ip:username` in the same Redis the rest of the process already uses.
const MAX_ATTEMPTS_PER_IP_AND_USERNAME = 10
const WINDOW_SECONDS = 60

async function assertNotRateLimited({ platformId, ip, username }: AssertNotRateLimitedParams): Promise<void> {
    const redis = await redisConnections.useExisting()
    const key = `ldap-sign-in:${platformId}:${ip}:${username.toLowerCase()}`
    const count = await redis.incr(key)
    if (count === 1) {
        await redis.expire(key, WINDOW_SECONDS)
    }
    if (count > MAX_ATTEMPTS_PER_IP_AND_USERNAME) {
        throw new QadamFlowError({
            code: ErrorCode.INVALID_CREDENTIALS,
            params: null,
        })
    }
}

export const ldapSignInRateLimit = {
    assertNotRateLimited,
}

type AssertNotRateLimitedParams = {
    platformId: string
    ip: string
    username: string
}

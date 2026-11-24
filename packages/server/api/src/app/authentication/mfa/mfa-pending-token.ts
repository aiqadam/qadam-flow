import { apId, ErrorCode, isNil, QadamFlowError, UserIdentityProvider } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { redisConnections } from '../../database/redis-connections'
import { jwtUtils } from '../../helper/jwt-utils'

// A challenge token is bound to the identity that just passed the first factor, is short-lived,
// is single-use (its jti is deleted from Redis on the one successful verification) and is
// deliberately *not* a `PrincipalType` the normal authorization middleware accepts. Only the MFA
// endpoints below understand it.
const PENDING_TTL_SECONDS = 5 * 60
const PENDING_KEY_PREFIX = 'mfa-pending:'

export enum MfaPendingPurpose {
    CHALLENGE = 'CHALLENGE',
    ENROLL = 'ENROLL',
}

export type MfaPendingClaims = {
    type: 'MFA_PENDING'
    purpose: MfaPendingPurpose
    identityId: string
    userId: string
    platformId: string
    provider: UserIdentityProvider
    tokenVersion: string | null
    expiresInSeconds?: number
    jti: string
}

export const mfaPendingToken = {
    issue,
    verify,
    consume,
}

async function issue(params: IssueParams): Promise<string> {
    const jti = apId() + nanoid()
    const claims: MfaPendingClaims = {
        type: 'MFA_PENDING',
        purpose: params.purpose,
        identityId: params.identityId,
        userId: params.userId,
        platformId: params.platformId,
        provider: params.provider,
        tokenVersion: params.tokenVersion,
        ...(params.expiresInSeconds === undefined ? {} : { expiresInSeconds: params.expiresInSeconds }),
        jti,
    }
    const redis = await redisConnections.useExisting()
    await redis.set(`${PENDING_KEY_PREFIX}${jti}`, '1', 'EX', PENDING_TTL_SECONDS)
    const secret = await jwtUtils.getJwtSecret()
    return jwtUtils.sign({
        payload: claims,
        key: secret,
        expiresInSeconds: PENDING_TTL_SECONDS,
    })
}

// Verifies signature, expiry and Redis presence, but does NOT consume the token — a failed code
// attempt may be retried within the window (subject to the MFA rate limit). Consumption happens
// only after the second factor succeeds.
async function verify({ token, log }: VerifyParams): Promise<MfaPendingClaims> {
    const secret = await jwtUtils.getJwtSecret()
    let claims: MfaPendingClaims
    try {
        claims = await jwtUtils.decodeAndVerify<MfaPendingClaims>({
            jwt: token,
            key: secret,
        })
    }
    catch (error) {
        log.warn({ err: error }, '[mfaPendingToken] Rejected an unverifiable MFA pending token')
        throw invalidChallenge()
    }
    if (claims.type !== 'MFA_PENDING' || isNil(claims.jti) || isNil(claims.identityId) || isNil(claims.purpose)) {
        throw invalidChallenge()
    }
    const redis = await redisConnections.useExisting()
    const exists = await redis.get(`${PENDING_KEY_PREFIX}${claims.jti}`)
    if (isNil(exists)) {
        throw invalidChallenge()
    }
    return claims
}

// Atomic single-use claim: `DEL` returns 1 only for the first caller; a replayed token gets 0.
async function consume({ claims }: ConsumeParams): Promise<void> {
    const redis = await redisConnections.useExisting()
    const deleted = await redis.del(`${PENDING_KEY_PREFIX}${claims.jti}`)
    if (deleted !== 1) {
        throw invalidChallenge()
    }
}

function invalidChallenge(): QadamFlowError {
    return new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
}

type IssueParams = {
    purpose: MfaPendingPurpose
    identityId: string
    userId: string
    platformId: string
    provider: UserIdentityProvider
    tokenVersion: string | null
    expiresInSeconds?: number
}

type VerifyParams = {
    token: string
    log: FastifyBaseLogger
}

type ConsumeParams = {
    claims: MfaPendingClaims
}

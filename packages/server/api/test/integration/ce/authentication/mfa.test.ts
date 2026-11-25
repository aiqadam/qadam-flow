import { ErrorCode, isNil, PlatformRole, UserIdentity } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { mfaTotp } from '../../../../src/app/authentication/mfa/totp'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { mockAndSaveBasicSetup, mockBasicUser } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

const PASSWORD = 'Sup3rSecretPassw0rd!'

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
    // The MFA rate limiter's counters live in Redis, which `cleanDatabase` does not touch — every
    // `app.inject()` call in this file resolves to the same fake client IP, so the per-IP bucket
    // would otherwise accumulate across tests and eventually rate-limit an unrelated test's first
    // attempt.
    const redis = await redisConnections.useExisting()
    const keys = await redis.keys('mfa-challenge:*')
    if (keys.length > 0) {
        await redis.del(...keys)
    }
})

function currentTotpCode(secret: string, stepOffset = 0): string {
    const step = Math.floor(Date.now() / 1000 / 30) + stepOffset
    return mfaTotp.generateCode({ secret, step })
}

async function setupOwner(params?: { enforced?: boolean }) {
    const { mockUserIdentity, mockOwner, mockPlatform } = await mockAndSaveBasicSetup({
        userIdentity: { password: PASSWORD, verified: true },
        platform: { mfaEnforced: params?.enforced ?? false },
    })
    return { identity: mockUserIdentity, user: mockOwner, platform: mockPlatform }
}

// A public sign-in request has no principal, so `platformUtils.getPlatformIdForRequest` resolves
// the platform by "oldest platform" rather than from the request — each test creates exactly one.
async function signIn(email: string, password: string) {
    return app?.inject({
        method: 'POST',
        url: '/api/v1/authentication/sign-in',
        body: { email, password },
    })
}

async function signInAsOwner(identity: UserIdentity): Promise<string> {
    const response = await signIn(identity.email, PASSWORD)
    return response?.json()?.token
}

// Confirming enrolment itself consumes "the current step" as the replay baseline (`mfaLastUsedStep`),
// so any TOTP code generated for a later call in the same test must use `stepOffset: 1` to land on
// a step that is both unused and still inside the server's own ±1 acceptance window.
async function enrollSelf(identity: UserIdentity): Promise<{ secret: string, recoveryCodes: string[] }> {
    const token = await signInAsOwner(identity)
    const startResponse = await app?.inject({
        method: 'POST',
        url: '/api/v1/mfa/enroll/start',
        headers: { authorization: `Bearer ${token}` },
        body: { password: PASSWORD },
    })
    const { secret } = startResponse?.json()
    const confirmResponse = await app?.inject({
        method: 'POST',
        url: '/api/v1/mfa/enroll/confirm',
        headers: { authorization: `Bearer ${token}` },
        body: { code: currentTotpCode(secret) },
    })
    if (confirmResponse?.statusCode !== StatusCodes.OK) {
        throw new Error(`enrollSelf failed to confirm: ${confirmResponse?.statusCode} ${confirmResponse?.body}`)
    }
    return { secret, recoveryCodes: confirmResponse?.json()?.recoveryCodes }
}

// Signs in an already-enrolled identity and clears the second factor, returning a real session
// token — unlike `signInAsOwner`, which only works before enrolment (sign-in alone returns a
// challenge, not a token, once MFA is enrolled).
async function signInAndChallenge(identity: UserIdentity, secret: string, stepOffset: number): Promise<string> {
    const signInResponse = await signIn(identity.email, PASSWORD)
    const verifyResponse = await app?.inject({
        method: 'POST',
        url: '/api/v1/mfa/challenge/verify',
        body: { mfaToken: signInResponse?.json()?.mfaToken, code: currentTotpCode(secret, stepOffset) },
    })
    if (verifyResponse?.statusCode !== StatusCodes.OK) {
        throw new Error(`signInAndChallenge failed: ${verifyResponse?.statusCode} ${verifyResponse?.body}`)
    }
    return verifyResponse?.json()?.token
}

describe('MFA (TOTP)', () => {
    describe('sign-in gate', () => {
        it('does not challenge a sign-in when enforcement is off and the user never enrolled', async () => {
            const { identity } = await setupOwner({ enforced: false })

            const response = await signIn(identity.email, PASSWORD)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body?.mfaRequired).toBeUndefined()
            expect(body?.token).toBeDefined()
        })

        it('forces enrolment when enforcement is on and the user has none', async () => {
            const { identity } = await setupOwner({ enforced: true })

            const response = await signIn(identity.email, PASSWORD)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body?.mfaRequired).toBe(true)
            expect(body?.mfaEnrollmentRequired).toBe(true)
            expect(body?.token).toBeUndefined()
        })

        it('completes forced enrolment through the pending token and returns a usable session', async () => {
            const { identity } = await setupOwner({ enforced: true })
            const signInResponse = await signIn(identity.email, PASSWORD)
            const mfaToken = signInResponse?.json()?.mfaToken

            const startResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/enroll/pending/start',
                body: { mfaToken },
            })
            expect(startResponse?.statusCode).toBe(StatusCodes.OK)
            const { secret } = startResponse?.json()

            const confirmResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/enroll/pending/confirm',
                body: { mfaToken, code: currentTotpCode(secret) },
            })

            expect(confirmResponse?.statusCode).toBe(StatusCodes.OK)
            const confirmBody = confirmResponse?.json()
            expect(confirmBody?.auth?.token).toBeDefined()
            expect(confirmBody?.recoveryCodes).toHaveLength(10)

            // The now-issued session actually works against a real endpoint.
            const meResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/users/me',
                headers: { authorization: `Bearer ${confirmBody.auth.token}` },
            })
            expect(meResponse?.statusCode).toBe(StatusCodes.OK)
        })

        it('challenges an already-enrolled user even when enforcement is off', async () => {
            const { identity } = await setupOwner({ enforced: false })
            const { secret } = await enrollSelf(identity)

            const response = await signIn(identity.email, PASSWORD)
            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body?.mfaRequired).toBe(true)
            expect(body?.mfaEnrollmentRequired).toBe(false)

            const verifyResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken: body.mfaToken, code: currentTotpCode(secret, 1) },
            })
            expect(verifyResponse?.statusCode).toBe(StatusCodes.OK)
            expect(verifyResponse?.json()?.token).toBeDefined()
        })

        it('rejects a wrong code and never issues a session', async () => {
            const { identity } = await setupOwner({ enforced: false })
            await enrollSelf(identity)

            const signInResponse = await signIn(identity.email, PASSWORD)
            const mfaToken = signInResponse?.json()?.mfaToken

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken, code: '000000' },
            })

            expect(response?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
            expect(response?.json()?.code).toBe(ErrorCode.MFA_INVALID_CODE)
        })

        it('single-use mfaToken: the same mfaToken cannot be presented a second time, even with its own just-accepted code', async () => {
            const { identity } = await setupOwner({ enforced: false })
            const { secret } = await enrollSelf(identity)
            const signInResponse = await signIn(identity.email, PASSWORD)
            const mfaToken = signInResponse?.json()?.mfaToken
            const code = currentTotpCode(secret, 1)

            const firstVerify = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken, code },
            })
            expect(firstVerify?.statusCode).toBe(StatusCodes.OK)

            // The token itself is checked (and found gone from Redis) before the code is ever
            // looked at again, so this fails as an invalid *token*, not a replayed *code*.
            const replayWithToken = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken, code },
            })
            expect(replayWithToken?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
            expect(replayWithToken?.json()?.code).toBe(ErrorCode.MFA_CHALLENGE_INVALID)
        })

        it('rejects replaying an already-accepted code for the same step', async () => {
            const { identity } = await setupOwner({ enforced: false })
            const { secret } = await enrollSelf(identity)
            const code = currentTotpCode(secret, 1)

            const firstSignIn = await signIn(identity.email, PASSWORD)
            const firstVerify = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken: firstSignIn?.json()?.mfaToken, code },
            })
            expect(firstVerify?.statusCode).toBe(StatusCodes.OK)

            const secondSignIn = await signIn(identity.email, PASSWORD)
            const secondVerify = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken: secondSignIn?.json()?.mfaToken, code },
            })
            expect(secondVerify?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        })

        it('accepts a single-use recovery code and rejects reusing it', async () => {
            const { identity } = await setupOwner({ enforced: false })
            const { recoveryCodes } = await enrollSelf(identity)
            const recoveryCode = recoveryCodes[0]

            const firstSignIn = await signIn(identity.email, PASSWORD)
            const firstVerify = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken: firstSignIn?.json()?.mfaToken, code: recoveryCode },
            })
            expect(firstVerify?.statusCode).toBe(StatusCodes.OK)

            const secondSignIn = await signIn(identity.email, PASSWORD)
            const secondVerify = await app?.inject({
                method: 'POST',
                url: '/api/v1/mfa/challenge/verify',
                body: { mfaToken: secondSignIn?.json()?.mfaToken, code: recoveryCode },
            })
            expect(secondVerify?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        })

        it('rate-limits repeated failed re-authentication on a self-service endpoint (not just sign-in)', async () => {
            const { identity } = await setupOwner({ enforced: false })
            const { secret } = await enrollSelf(identity)
            const token = await signInAndChallenge(identity, secret, 1)
            if (isNil(app)) {
                throw new Error('test app not initialized')
            }
            const instance = app

            const attempts = await Promise.all(Array.from({ length: 11 }, () => instance.inject({
                method: 'POST',
                url: '/api/v1/mfa/disable',
                headers: { authorization: `Bearer ${token}` },
                body: { code: '000000' },
            })))

            expect(attempts.some((response) => response.statusCode === StatusCodes.TOO_MANY_REQUESTS)).toBe(true)
            expect(attempts.every((response) => response.statusCode !== StatusCodes.OK)).toBe(true)
        })
    })

    describe('admin reset and owner protection', () => {
        it('lets the owner reset a non-owner admin\'s MFA', async () => {
            const { identity: ownerIdentity, platform } = await setupOwner({ enforced: false })
            const ownerToken = await signInAsOwner(ownerIdentity)

            const { mockUser: targetAdmin, mockUserIdentity: targetIdentity } = await mockBasicUser({
                userIdentity: { password: PASSWORD, verified: true },
                user: { platformId: platform.id, platformRole: PlatformRole.ADMIN },
            })
            await enrollSelf(targetIdentity)

            const resetResponse = await app?.inject({
                method: 'POST',
                url: `/api/v1/mfa/admin/reset/${targetAdmin.id}`,
                headers: { authorization: `Bearer ${ownerToken}` },
            })

            expect(resetResponse?.statusCode).toBe(StatusCodes.NO_CONTENT)
            const reloaded = await databaseConnection().getRepository('user_identity').findOneBy({ id: targetIdentity.id }) as UserIdentity
            expect(reloaded.mfaEnabled).toBe(false)
        })

        it('never lets a reset target the platform owner', async () => {
            const { identity: ownerIdentity, user: owner } = await setupOwner({ enforced: false })
            const { secret } = await enrollSelf(ownerIdentity)
            const ownerToken = await signInAndChallenge(ownerIdentity, secret, 1)

            const resetResponse = await app?.inject({
                method: 'POST',
                url: `/api/v1/mfa/admin/reset/${owner.id}`,
                headers: { authorization: `Bearer ${ownerToken}` },
            })

            expect(resetResponse?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(resetResponse?.json()?.code).toBe(ErrorCode.MFA_RESET_NOT_ALLOWED_FOR_OWNER)
        })

        it('does not let a non-owner admin reset another admin', async () => {
            const { platform } = await setupOwner({ enforced: false })

            const { mockUserIdentity: actingIdentity } = await mockBasicUser({
                userIdentity: { password: PASSWORD, verified: true },
                user: { platformId: platform.id, platformRole: PlatformRole.ADMIN },
            })
            const { mockUser: targetAdmin } = await mockBasicUser({
                userIdentity: { password: PASSWORD, verified: true },
                user: { platformId: platform.id, platformRole: PlatformRole.ADMIN },
            })

            const actingToken = await signInAsOwner(actingIdentity)
            const resetResponse = await app?.inject({
                method: 'POST',
                url: `/api/v1/mfa/admin/reset/${targetAdmin.id}`,
                headers: { authorization: `Bearer ${actingToken}` },
            })

            expect(resetResponse?.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })
})

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { cryptoUtils } from '@aiqadam/server-utils'
import {
    ApplicationEventName,
    AuthenticationResponse,
    ErrorCode,
    isNil,
    MfaChallengeResponse,
    MfaEnrollmentConfirmResponse,
    MfaEnrollmentStartResponse,
    MfaStatusResponse,
    PlatformRole,
    QadamFlowError,
    SignInResponse,
    User,
    UserIdentity,
    UserIdentityProvider,
    UserStatus,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { applicationEvents } from '../../helper/application-events'
import { encryptUtils } from '../../helper/encryption'
import { platformService } from '../../platform/platform.service'
import { userService } from '../../user/user-service'
import { authenticationUtils } from '../authentication-utils'
import { passwordHasher } from '../lib/password-hasher'
import { userIdentityService } from '../user-identity/user-identity-service'
import { MfaPendingClaims, MfaPendingPurpose, mfaPendingToken } from './mfa-pending-token'
import { mfaRateLimit } from './mfa-rate-limit'
import { mfaTotp } from './totp'

const RECOVERY_CODE_COUNT = 10
const ISSUER = 'Qadam Flow'

export const mfaService = (log: FastifyBaseLogger) => ({
    // Called by every interactive sign-in path that has just verified the first factor. Returns
    // either a full session or a challenge; a challenge never carries a usable session token.
    async beginMfaGate(params: Omit<BeginMfaGateParams, 'log'>): Promise<SignInResponse> {
        const { identity, user, platformId, provider } = params
        const platform = await platformService(log).getOneOrThrow(platformId)

        if (provider === UserIdentityProvider.JWT) {
            return issueSession({ ...params, log })
        }

        const trusted = isTrustedProvider({ platform, provider })
        const challengeEnrolled = identity.mfaEnabled === true && !trusted
        const enrollmentRequired = identity.mfaEnabled !== true
            && !trusted
            && isEnforcementActive(platform)

        if (!challengeEnrolled && !enrollmentRequired) {
            return issueSession({ ...params, log })
        }

        const mfaToken = await mfaPendingToken.issue({
            purpose: enrollmentRequired ? MfaPendingPurpose.ENROLL : MfaPendingPurpose.CHALLENGE,
            identityId: identity.id,
            userId: user.id,
            platformId,
            provider,
            tokenVersion: identity.tokenVersion ?? null,
            expiresInSeconds: params.expiresInSeconds,
        })
        const challenge: MfaChallengeResponse = {
            mfaRequired: true,
            mfaEnrollmentRequired: enrollmentRequired,
            mfaToken,
        }
        return challenge
    },

    async getStatus({ userId, platformId }: GetStatusParams): Promise<MfaStatusResponse> {
        const user = await userService(log).getOneOrFail({ id: userId })
        const identity = await userIdentityService(log).getOneOrFail({ id: user.identityId })
        const platform = await platformService(log).getOneOrThrow(platformId)
        return {
            enrolled: identity.mfaEnabled === true,
            recoveryCodesRemaining: identity.mfaRecoveryCodes?.length ?? 0,
            enforced: isEnforcementActive(platform),
        }
    },

    async startPendingEnrollment({ mfaToken, ip }: StartPendingEnrollmentParams): Promise<MfaEnrollmentStartResponse> {
        const claims = await mfaPendingToken.verify({ token: mfaToken, log })
        if (claims.purpose !== MfaPendingPurpose.ENROLL) {
            throw new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
        }
        const identity = await loadPendingIdentity({ claims, log })
        if (identity.mfaEnabled === true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_ALREADY_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        return startEnrollment({ identity, platformId: claims.platformId, log })
    },

    async confirmPendingEnrollment({ mfaToken, code, ip }: ConfirmPendingEnrollmentParams): Promise<{ auth: AuthenticationResponse, recoveryCodes: string[] }> {
        const claims = await mfaPendingToken.verify({ token: mfaToken, log })
        if (claims.purpose !== MfaPendingPurpose.ENROLL) {
            throw new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
        }
        const identity = await loadPendingIdentity({ claims, log })
        if (identity.mfaEnabled === true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_ALREADY_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        const { recoveryCodes } = await confirmEnrollment({ identity, code, log })
        await mfaPendingToken.consume({ claims })
        log.info({ identityId: identity.id, platformId: claims.platformId }, 'MFA enrolled after forced-enrolment challenge')
        sendAudit({ platformId: claims.platformId, userId: claims.userId, action: ApplicationEventName.USER_MFA_ENROLLED, log })
        const auth = await authenticationUtils(log).getProjectAndToken({
            userId: claims.userId,
            platformId: claims.platformId,
            projectId: null,
            expiresInSeconds: claims.expiresInSeconds,
        })
        return { auth, recoveryCodes }
    },

    async verifyChallenge({ mfaToken, code, ip }: VerifyChallengeParams): Promise<AuthenticationResponse> {
        const claims = await mfaPendingToken.verify({ token: mfaToken, log })
        if (claims.purpose !== MfaPendingPurpose.CHALLENGE) {
            throw new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
        }
        const identity = await loadPendingIdentity({ claims, log })
        if (identity.mfaEnabled !== true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_NOT_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        const result = await verifySecondFactor({ identity, code, log })
        if (!result.ok) {
            sendAudit({ platformId: claims.platformId, userId: claims.userId, action: ApplicationEventName.USER_MFA_CHALLENGE_FAILED, log })
            throw new QadamFlowError({ code: ErrorCode.MFA_INVALID_CODE, params: {} })
        }
        await mfaPendingToken.consume({ claims })
        sendAudit({ platformId: claims.platformId, userId: claims.userId, action: ApplicationEventName.USER_MFA_CHALLENGE_SUCCEEDED, log })
        log.info({ identityId: identity.id, platformId: claims.platformId, usedRecoveryCode: result.usedRecoveryCode }, 'MFA challenge passed')
        return authenticationUtils(log).getProjectAndToken({
            userId: claims.userId,
            platformId: claims.platformId,
            projectId: null,
            expiresInSeconds: claims.expiresInSeconds,
        })
    },

    async startAuthenticatedEnrollment({ identity, userId, platformId, password, code, ip }: StartAuthenticatedEnrollmentParams): Promise<MfaEnrollmentStartResponse> {
        if (identity.mfaEnabled === true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_ALREADY_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        await assertReauthenticated({ identity, userId, platformId, password, code, allowOwnerPasswordBypass: false, log })
        return startEnrollment({ identity, platformId, log })
    },

    async confirmAuthenticatedEnrollment({ identity, userId, platformId, code, ip }: ConfirmAuthenticatedEnrollmentParams): Promise<MfaEnrollmentConfirmResponse> {
        if (identity.mfaEnabled === true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_ALREADY_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        const { recoveryCodes } = await confirmEnrollment({ identity, code, log })
        sendAudit({ platformId, userId, action: ApplicationEventName.USER_MFA_ENROLLED, log })
        return { recoveryCodes }
    },

    async disable({ identity, user, platformId, password, code, ip }: DisableParams): Promise<AuthenticationResponse> {
        if (identity.mfaEnabled !== true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_NOT_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        await assertReauthenticated({ identity, userId: user.id, platformId, password, code, allowOwnerPasswordBypass: true, log })
        await userIdentityService(log).updateMfa({
            id: identity.id,
            mfaEnabled: false,
            mfaSecret: null,
            mfaPendingSecret: null,
            mfaRecoveryCodes: null,
            mfaEnrolledAt: null,
            mfaLastUsedStep: null,
        })
        await userIdentityService(log).rotateTokenVersion(identity.id)
        sendAudit({ platformId, userId: user.id, action: ApplicationEventName.USER_MFA_DISABLED, log })
        log.info({ identityId: identity.id, userId: user.id }, 'MFA disabled by the user')
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
        })
    },

    async regenerateRecoveryCodes({ identity, userId, platformId, password, code, ip }: RegenerateRecoveryCodesParams): Promise<MfaEnrollmentConfirmResponse> {
        if (identity.mfaEnabled !== true) {
            throw new QadamFlowError({ code: ErrorCode.MFA_NOT_ENROLLED, params: {} })
        }
        await mfaRateLimit.assertNotRateLimited({ identityId: identity.id, ip, log })
        await assertReauthenticated({ identity, userId, platformId, password, code, allowOwnerPasswordBypass: false, log })
        const { plaintext, hashes } = generateRecoveryCodes()
        await userIdentityService(log).updateMfa({ id: identity.id, mfaRecoveryCodes: hashes })
        return { recoveryCodes: plaintext }
    },

    // Admin-initiated reset. Never touches the platform owner, and a non-owner admin may not reset
    // another admin — the two rules that keep this from becoming a takeover primitive.
    async adminReset({ platformId, targetUserId, actorUserId }: AdminResetParams): Promise<void> {
        const platform = await platformService(log).getOneOrThrow(platformId)
        const targetUser = await userService(log).getOneByIdAndPlatformIdOrThrow({ id: targetUserId, platformId })
        if (targetUser.id === platform.ownerId) {
            throw new QadamFlowError({ code: ErrorCode.MFA_RESET_NOT_ALLOWED_FOR_OWNER, params: {} })
        }
        const actor = await userService(log).getOneOrFail({ id: actorUserId })
        const actorIsOwner = actor.id === platform.ownerId
        if (targetUser.platformRole === PlatformRole.ADMIN && !actorIsOwner) {
            throw new QadamFlowError({ code: ErrorCode.MFA_RESET_NOT_ALLOWED_FOR_OWNER, params: {} })
        }
        // `targetUser` came back from a platform-scoped lookup (the data-isolation guard); this
        // second fetch by its own trusted id is only to read `identityId`, which that DTO strips.
        const targetUserIdentity = await userService(log).getOneOrFail({ id: targetUser.id })
        await userIdentityService(log).updateMfa({
            id: targetUserIdentity.identityId,
            mfaEnabled: false,
            mfaSecret: null,
            mfaPendingSecret: null,
            mfaRecoveryCodes: null,
            mfaEnrolledAt: null,
            mfaLastUsedStep: null,
        })
        await userIdentityService(log).rotateTokenVersion(targetUserIdentity.identityId)
        sendAudit({ platformId, userId: targetUser.id, action: ApplicationEventName.USER_MFA_RESET, log })
        log.warn({ platformId, targetUserId, actorUserId }, 'MFA reset by an administrator')
    },
})

async function issueSession(params: BeginMfaGateParams): Promise<AuthenticationResponse> {
    return authenticationUtils(params.log).getProjectAndToken({
        userId: params.user.id,
        platformId: params.platformId,
        projectId: params.projectId,
        expiresInSeconds: params.expiresInSeconds,
    })
}

async function loadPendingIdentity({ claims, log }: { claims: MfaPendingClaims, log: FastifyBaseLogger }): Promise<UserIdentity> {
    const identity = await userIdentityService(log).getOneOrFail({ id: claims.identityId })
    if ((identity.tokenVersion ?? null) !== (claims.tokenVersion ?? null) || identity.provider !== claims.provider || identity.verified !== true) {
        throw new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
    }
    const user = await userService(log).getOneOrFail({ id: claims.userId })
    if (user.platformId !== claims.platformId || user.identityId !== identity.id || user.status === UserStatus.INACTIVE) {
        throw new QadamFlowError({ code: ErrorCode.MFA_CHALLENGE_INVALID, params: {} })
    }
    return identity
}

async function startEnrollment({ identity, platformId, log }: StartEnrollmentParams): Promise<MfaEnrollmentStartResponse> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    const secret = mfaTotp.generateSecret()
    const encrypted = await encryptUtils.encryptString(secret)
    await userIdentityService(log).updateMfa({ id: identity.id, mfaPendingSecret: encrypted })
    return {
        secret,
        otpauthUrl: mfaTotp.buildOtpauthUrl({ secret, accountName: identity.email, issuer: platform.name || ISSUER }),
    }
}

async function confirmEnrollment({ identity, code, log }: ConfirmEnrollmentParams): Promise<{ recoveryCodes: string[] }> {
    if (isNil(identity.mfaPendingSecret)) {
        throw new QadamFlowError({ code: ErrorCode.MFA_NOT_ENROLLED, params: {} })
    }
    const pendingSecret = await encryptUtils.decryptString(identity.mfaPendingSecret)
    const step = mfaTotp.verify({ secret: pendingSecret, code })
    if (isNil(step)) {
        throw new QadamFlowError({ code: ErrorCode.MFA_INVALID_CODE, params: {} })
    }
    if (!isNil(identity.mfaLastUsedStep) && step <= identity.mfaLastUsedStep) {
        throw new QadamFlowError({ code: ErrorCode.MFA_INVALID_CODE, params: {} })
    }
    const { plaintext, hashes } = generateRecoveryCodes()
    await userIdentityService(log).updateMfa({
        id: identity.id,
        mfaEnabled: true,
        mfaSecret: identity.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaRecoveryCodes: hashes,
        mfaEnrolledAt: new Date().toISOString(),
        mfaLastUsedStep: step,
    })
    return { recoveryCodes: plaintext }
}

async function verifySecondFactor({ identity, code, log }: VerifySecondFactorParams): Promise<SecondFactorResult> {
    if (!isNil(identity.mfaSecret)) {
        const secret = await encryptUtils.decryptString(identity.mfaSecret)
        const step = mfaTotp.verify({ secret, code })
        if (!isNil(step) && (isNil(identity.mfaLastUsedStep) || step > identity.mfaLastUsedStep)) {
            await userIdentityService(log).updateMfa({ id: identity.id, mfaLastUsedStep: step })
            return { ok: true, usedRecoveryCode: false }
        }
        if (!isNil(step)) {
            // Valid arithmetic, but this time-step was already accepted: replay.
            return { ok: false, usedRecoveryCode: false }
        }
    }
    const recoveryIndex = findRecoveryCodeIndex({ identity, code })
    if (recoveryIndex === -1) {
        return { ok: false, usedRecoveryCode: false }
    }
    const remaining = (identity.mfaRecoveryCodes ?? []).filter((_, index) => index !== recoveryIndex)
    await userIdentityService(log).updateMfa({ id: identity.id, mfaRecoveryCodes: remaining })
    return { ok: true, usedRecoveryCode: true }
}

function findRecoveryCodeIndex({ identity, code }: FindRecoveryCodeIndexParams): number {
    const normalized = normalizeRecoveryCode(code)
    const presented = createHash('sha256').update(normalized).digest()
    const codes = identity.mfaRecoveryCodes ?? []
    return codes.findIndex((hash) => {
        const stored = Buffer.from(hash, 'hex')
        return stored.length === presented.length && timingSafeEqual(stored, presented)
    })
}

async function assertReauthenticated(params: AssertReauthenticatedParams): Promise<void> {
    const { identity, password, code, log } = params
    if (identity.mfaEnabled === true) {
        if (!isNil(code)) {
            const result = await verifySecondFactor({ identity, code, log })
            if (result.ok) {
                return
            }
        }
        if (params.allowOwnerPasswordBypass && await tryOwnerPasswordBypass(params)) {
            return
        }
        throw new QadamFlowError({ code: ErrorCode.MFA_INVALID_CODE, params: {} })
    }
    if (identity.provider === UserIdentityProvider.EMAIL) {
        if (isNil(password) || !(await passwordHasher.compare(password, identity.password))) {
            throw new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
        }
        return
    }
    // Federated identities (Google/SAML/LDAP) have no local password to re-enter; the current,
    // still-valid session is the re-authentication proof, and any MFA they *do* have was required
    // above. This is the documented SSO assumption in the PR.
}

async function tryOwnerPasswordBypass(params: AssertReauthenticatedParams): Promise<boolean> {
    const { identity, userId, platformId, password, log } = params
    if (identity.provider !== UserIdentityProvider.EMAIL || isNil(password) || isNil(userId) || isNil(platformId)) {
        return false
    }
    const platform = await platformService(log).getOneOrThrow(platformId)
    if (platform.ownerId !== userId) {
        return false
    }
    const matches = await passwordHasher.compare(password, identity.password)
    if (matches) {
        log.warn({ userId, platformId }, 'Platform owner used the password break-glass path to re-authenticate for MFA')
    }
    return matches
}

function generateRecoveryCodes(): { plaintext: string[], hashes: string[] } {
    const plaintext: string[] = []
    const hashes: string[] = []
    for (let index = 0; index < RECOVERY_CODE_COUNT; index++) {
        const raw = mfaTotp.encodeBase32(randomBytes(6)).slice(0, 10).toLowerCase()
        const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`
        plaintext.push(formatted)
        hashes.push(cryptoUtils.hashSHA256(normalizeRecoveryCode(formatted)))
    }
    return { plaintext, hashes }
}

function normalizeRecoveryCode(code: string): string {
    return code.toUpperCase().replace(/[^A-Z2-7]/g, '')
}

function isTrustedProvider({ platform, provider }: { platform: { mfaTrustedIdpProviders: UserIdentityProvider[] }, provider: UserIdentityProvider }): boolean {
    // LDAP is never covered by "trust the IdP": a bind carries no authentication-context signal
    // (#339), so the platform must always perform the second factor itself for directory users.
    if (provider === UserIdentityProvider.LDAP || provider === UserIdentityProvider.JWT) {
        return false
    }
    return platform.mfaTrustedIdpProviders.includes(provider)
}

function isEnforcementActive(platform: { mfaEnforced: boolean, mfaEnforcementGracePeriodDays: number, mfaEnforcementEnabledAt?: string | null }): boolean {
    if (!platform.mfaEnforced) {
        return false
    }
    if (platform.mfaEnforcementGracePeriodDays <= 0 || isNil(platform.mfaEnforcementEnabledAt)) {
        return true
    }
    const enabledAt = new Date(platform.mfaEnforcementEnabledAt).getTime()
    const deadline = enabledAt + platform.mfaEnforcementGracePeriodDays * 24 * 60 * 60 * 1000
    return Date.now() >= deadline
}

function sendAudit({ platformId, userId, action, log }: SendAuditParams): void {
    applicationEvents(log).sendUserEvent({ platformId, userId }, { action, data: {} })
}

type BeginMfaGateParams = {
    identity: UserIdentity
    user: User
    platformId: string
    projectId: string | null
    expiresInSeconds?: number
    provider: UserIdentityProvider
    log: FastifyBaseLogger
}

type GetStatusParams = {
    userId: string
    platformId: string
}

type StartPendingEnrollmentParams = {
    mfaToken: string
    ip: string
}

type ConfirmPendingEnrollmentParams = {
    mfaToken: string
    code: string
    ip: string
}

type VerifyChallengeParams = {
    mfaToken: string
    code: string
    ip: string
}

type StartAuthenticatedEnrollmentParams = {
    identity: UserIdentity
    userId: string
    platformId: string
    password?: string
    code?: string
    ip: string
}

type ConfirmAuthenticatedEnrollmentParams = {
    identity: UserIdentity
    userId: string
    platformId: string
    code: string
    ip: string
}

type DisableParams = {
    identity: UserIdentity
    user: User
    platformId: string
    password?: string
    code?: string
    ip: string
}

type RegenerateRecoveryCodesParams = {
    identity: UserIdentity
    userId: string
    platformId: string
    password?: string
    code?: string
    ip: string
}

type AdminResetParams = {
    platformId: string
    targetUserId: string
    actorUserId: string
}

type StartEnrollmentParams = {
    identity: UserIdentity
    platformId: string
    log: FastifyBaseLogger
}

type ConfirmEnrollmentParams = {
    identity: UserIdentity
    code: string
    log: FastifyBaseLogger
}

type VerifySecondFactorParams = {
    identity: UserIdentity
    code: string
    log: FastifyBaseLogger
}

type SecondFactorResult = {
    ok: boolean
    usedRecoveryCode: boolean
}

type FindRecoveryCodeIndexParams = {
    identity: UserIdentity
    code: string
}

type AssertReauthenticatedParams = {
    identity: UserIdentity
    userId: string | null
    platformId: string | null
    password?: string
    code?: string
    allowOwnerPasswordBypass: boolean
    log: FastifyBaseLogger
}

type SendAuditParams = {
    platformId: string
    userId: string
    action: ApplicationEventName
    log: FastifyBaseLogger
}

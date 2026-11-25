import {
    ApId,
    AuthenticationResponse,
    MfaEnrollmentConfirmAuthenticatedRequest,
    MfaEnrollmentConfirmRequest,
    MfaEnrollmentConfirmResponse,
    MfaEnrollmentConfirmWithSessionResponse,
    MfaEnrollmentStartRequest,
    MfaEnrollmentStartResponse,
    MfaReauthenticationRequest,
    MfaStatusResponse,
    MfaVerifyRequest,
    PrincipalType,
    User,
    UserIdentity,
} from '@aiqadam/shared'
import { RateLimitOptions } from '@fastify/rate-limit'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { networkUtils } from '../../helper/network-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { userService } from '../../user/user-service'
import { userIdentityService } from '../user-identity/user-identity-service'
import { mfaService } from './mfa-service'

export const mfaController: FastifyPluginAsyncZod = async (app) => {
    // --- Continuations of a sign-in that is pending on the second factor. Authenticated only by
    // the single-purpose `mfaToken` in the body, never by a session principal. ---

    app.post('/challenge/verify', VerifyChallengeRequest, async (request) => {
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).verifyChallenge({ mfaToken: request.body.mfaToken, code: request.body.code, ip })
    })

    app.post('/enroll/pending/start', StartPendingEnrollmentRequest, async (request) => {
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).startPendingEnrollment({ mfaToken: request.body.mfaToken, ip })
    })

    app.post('/enroll/pending/confirm', ConfirmPendingEnrollmentRequest, async (request) => {
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).confirmPendingEnrollment({ mfaToken: request.body.mfaToken, code: request.body.code, ip })
    })

    // --- Self-service, for an already-signed-in user. ---

    app.get('/status', GetStatusRequest, async (request) => {
        return mfaService(request.log).getStatus({ userId: request.principal.id, platformId: request.principal.platform.id })
    })

    app.post('/enroll/start', StartAuthenticatedEnrollmentRequest, async (request) => {
        const { identity, user } = await loadSelf(request.principal.id, request.log)
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).startAuthenticatedEnrollment({
            identity,
            userId: user.id,
            platformId: request.principal.platform.id,
            password: request.body.password,
            code: request.body.code,
            ip,
        })
    })

    app.post('/enroll/confirm', ConfirmAuthenticatedEnrollmentRequest, async (request) => {
        const { identity, user } = await loadSelf(request.principal.id, request.log)
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).confirmAuthenticatedEnrollment({
            identity,
            userId: user.id,
            platformId: request.principal.platform.id,
            code: request.body.code,
            ip,
        })
    })

    app.post('/disable', DisableRequest, async (request) => {
        const { identity, user } = await loadSelf(request.principal.id, request.log)
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).disable({
            identity,
            user,
            platformId: request.principal.platform.id,
            password: request.body.password,
            code: request.body.code,
            ip,
        })
    })

    app.post('/recovery-codes/regenerate', RegenerateRecoveryCodesRequest, async (request) => {
        const { identity, user } = await loadSelf(request.principal.id, request.log)
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        return mfaService(request.log).regenerateRecoveryCodes({
            identity,
            userId: user.id,
            platformId: request.principal.platform.id,
            password: request.body.password,
            code: request.body.code,
            ip,
        })
    })

    // --- Platform admin only. ---

    app.post('/admin/reset/:userId', AdminResetRequest, async (request, reply) => {
        await mfaService(request.log).adminReset({
            platformId: request.principal.platform.id,
            targetUserId: request.params.userId,
            actorUserId: request.principal.id,
        })
        return reply.status(StatusCodes.NO_CONTENT).send()
    })
}

async function loadSelf(userId: string, log: FastifyBaseLogger): Promise<{ user: User, identity: UserIdentity }> {
    const user = await userService(log).getOrThrow({ id: userId })
    const identity = await userIdentityService(log).getOneOrFail({ id: user.identityId })
    return { user, identity }
}

const rateLimitOptions: RateLimitOptions = {
    max: Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX), 10),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
}

const VerifyChallengeRequest = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaVerifyRequest,
        response: {
            [StatusCodes.OK]: AuthenticationResponse,
        },
    },
}

const StartPendingEnrollmentRequest = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaEnrollmentStartRequest,
        response: {
            [StatusCodes.OK]: MfaEnrollmentStartResponse,
        },
    },
}

const ConfirmPendingEnrollmentRequest = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaEnrollmentConfirmRequest,
        response: {
            [StatusCodes.OK]: MfaEnrollmentConfirmWithSessionResponse,
        },
    },
}

const GetStatusRequest = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER]),
    },
    schema: {
        response: {
            [StatusCodes.OK]: MfaStatusResponse,
        },
    },
}

const StartAuthenticatedEnrollmentRequest = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER]),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaReauthenticationRequest,
        response: {
            [StatusCodes.OK]: MfaEnrollmentStartResponse,
        },
    },
}

const ConfirmAuthenticatedEnrollmentRequest = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER]),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaEnrollmentConfirmAuthenticatedRequest,
        response: {
            [StatusCodes.OK]: MfaEnrollmentConfirmResponse,
        },
    },
}

const DisableRequest = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER]),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaReauthenticationRequest,
        response: {
            [StatusCodes.OK]: AuthenticationResponse,
        },
    },
}

const RegenerateRecoveryCodesRequest = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER]),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: MfaReauthenticationRequest,
        response: {
            [StatusCodes.OK]: MfaEnrollmentConfirmResponse,
        },
    },
}

const AdminResetRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        params: z.object({
            userId: ApId,
        }),
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
    },
}

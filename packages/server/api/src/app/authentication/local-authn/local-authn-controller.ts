import {
    ResetPasswordRequestBody,
    UserIdentityWithoutSensitiveData,
    VerifyEmailRequestBody } from '@aiqadam/shared'
import { RateLimitOptions } from '@fastify/rate-limit'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { localAuthnService } from './local-authn-service'

export const localAuthnController: FastifyPluginAsyncZod = async (app) => {
    app.post('/verify-email', VerifyEmailRequest, async (req) => {
        return localAuthnService(req.log).verifyEmail(req.body)
    })

    app.post('/reset-password', ResetPasswordRequest, async (req) => {
        await localAuthnService(req.log).resetPassword(req.body)
    })
}

const rateLimitOptions: RateLimitOptions = {
    max: Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX), 10),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
}

const VerifyEmailRequest = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: VerifyEmailRequestBody,
        response: {
            [StatusCodes.OK]: UserIdentityWithoutSensitiveData,
        },
    },
}

const ResetPasswordRequest = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: ResetPasswordRequestBody,
    },
}

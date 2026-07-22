import {
    ResetPasswordRequestBody,
    VerifyEmailRequestBody } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { localAuthnService } from './local-authn-service'

export const localAuthnController: FastifyPluginAsyncZod = async (app) => {
    app.post('/verify-email', VerifyEmailRequest, async (req) => {
        return localAuthnService(req.log).verifyEmail(req.body)
    })

    app.post('/reset-password', ResetPasswordRequest, async (req) => {
        await localAuthnService(req.log).resetPassword(req.body)
    })
}

const VerifyEmailRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        body: VerifyEmailRequestBody,
    },
}

const ResetPasswordRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        body: ResetPasswordRequestBody,
    },
}

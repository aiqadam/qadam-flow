import { ApplicationEventName, ErrorCode, isNil, LdapSignInRequest, QadamFlowError } from '@aiqadam/shared'
import { RateLimitOptions } from '@fastify/rate-limit'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { applicationEvents } from '../../helper/application-events'
import { networkUtils } from '../../helper/network-utils'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { platformUtils } from '../../platform/platform.utils'
import { ldapAuthnService } from './ldap-authn-service'
import { ldapSignInRateLimit } from './ldap-sign-in-rate-limit'

export const ldapAuthnController: FastifyPluginAsyncZod = async (app) => {
    app.post('/sign-in', SignInRequestOptions, async (request) => {
        const ip = networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER))
        const platformId = await platformUtils.getPlatformIdForRequest(request)
        if (isNil(platformId)) {
            throw new QadamFlowError({
                code: ErrorCode.LDAP_DIRECTORY_UNREACHABLE,
                params: {},
            })
        }
        await ldapSignInRateLimit.assertNotRateLimited({ platformId, ip, username: request.body.username })

        const response = await ldapAuthnService(request.log).signIn({
            platformId,
            username: request.body.username,
            password: request.body.password,
        })

        applicationEvents(request.log).sendUserEvent({
            platformId,
            userId: response.id,
            projectId: response.projectId ?? undefined,
            ip,
        }, {
            action: ApplicationEventName.USER_SIGNED_IN,
            data: {},
        })

        return response
    })
}

const rateLimitOptions: RateLimitOptions = {
    max: Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX), 10),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
}

const SignInRequestOptions = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: LdapSignInRequest,
    },
}

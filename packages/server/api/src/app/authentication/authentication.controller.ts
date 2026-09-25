import { ApplicationEventName,
    isNil,
    PrincipalType,
    SignInRequest,
    SignUpRequest,
    SwitchPlatformRequest,
    UserIdentityProvider,
} from '@aiqadam/shared'
import { RateLimitOptions } from '@fastify/rate-limit'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { applicationEvents } from '../helper/application-events'
import { jwtUtils } from '../helper/jwt-utils'
import { networkUtils } from '../helper/network-utils'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { platformUtils } from '../platform/platform.utils'
import { userService } from '../user/user-service'
import { authenticationService } from './authentication.service'

export const authenticationController: FastifyPluginAsyncZod = async (
    app,
) => {
    app.post('/sign-up', SignUpRequestOptions, async (request) => {

        const platformId = await platformUtils.getPlatformIdForRequest(request)
        const signUpResponse = await authenticationService(request.log).signUp({
            ...request.body,
            provider: UserIdentityProvider.EMAIL,
            platformId: platformId ?? null,
        })

        if (!isNil(signUpResponse.platformId)) {
            applicationEvents(request.log).sendUserEvent({
                platformId: signUpResponse.platformId,
                userId: signUpResponse.id,
                projectId: signUpResponse.projectId ?? undefined,
                ip: networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER)),
            }, {
                action: ApplicationEventName.USER_SIGNED_UP,
                data: {
                    source: 'credentials',
                },
            })
        }

        return signUpResponse
    })

    app.post('/sign-in', SignInRequestOptions, async (request) => {

        const predefinedPlatformId = await platformUtils.getPlatformIdForRequest(request)
        const response = await authenticationService(request.log).signInWithPassword({
            email: request.body.email,
            password: request.body.password,
            predefinedPlatformId,
        })

        if (!isNil(response.platformId)) {
            applicationEvents(request.log).sendUserEvent({
                platformId: response.platformId,
                userId: response.id,
                projectId: response.projectId ?? undefined,
                ip: networkUtils.extractClientRealIp(request, system.get(AppSystemProp.CLIENT_REAL_IP_HEADER)),
            }, {
                action: ApplicationEventName.USER_SIGNED_IN,
                data: {},
            })
        }

        return response
    })

    app.post('/switch-platform', SwitchPlatformRequestOptions, async (request) => {
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        return authenticationService(request.log).switchPlatform({
            identityId: user.identityId,
            platformId: request.body.platformId,
            currentTokenExpiresAtSeconds: getCurrentTokenExpiresAtSeconds(request),
        })
    })

}

// The authorization middleware already verified this token before the handler ran — this reads
// the already-trusted `exp` claim back out, purely so `switchPlatform` can cap an LDAP identity's
// reissued token at the current session's own remaining lifetime (see the comment on
// `getSwitchPlatformExpiresInSeconds` in `authentication.service.ts`). `jwtUtils.decode` never
// re-checks the signature, which is fine here — a forged token could not have reached this
// far — but that also means this must never be used for anything but reading a claim off a
// request the middleware already trusts.
function getCurrentTokenExpiresAtSeconds(request: FastifyRequest): number | undefined {
    const header = request.headers.authorization
    if (isNil(header)) {
        return undefined
    }
    const token = header.replace(/^Bearer\s+/i, '')
    const decoded = jwtUtils.decode<{ exp?: number }>({ jwt: token })
    return decoded?.payload.exp
}

const rateLimitOptions: RateLimitOptions = {
    max: Number.parseInt(
        system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX),
        10,
    ),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
}



const SwitchPlatformRequestOptions = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: SwitchPlatformRequest,
    },
}

const SignUpRequestOptions = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: SignUpRequest,
    },
}

const SignInRequestOptions = {
    config: {
        security: securityAccess.public(),
        rateLimit: rateLimitOptions,
    },
    schema: {
        body: SignInRequest,
    },
}

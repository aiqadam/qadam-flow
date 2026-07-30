import {
    AppConnectionType,
    ErrorCode,
    PlatformOAuth2ConnectionValue,
    QadamFlowError,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import {
    ClaimOAuth2Request,
    OAuth2Service,
    RefreshOAuth2Request,
} from './oauth2-service'
import { credentialsOauth2Service } from './services/credentials-oauth2-service'

// PLATFORM_OAUTH2 is accepted by the upsert request schema but no platform-managed OAuth2 app
// exists to service it, so this always rejects. It throws a QadamFlowError rather than a bare Error
// because a bare one has no statusCode: the error handler then answers 500 and reports to the
// exception handler, so a predictable client input produced a server error plus alert noise.
// INVALID_APP_CONNECTION is absent from the handler's statusCodeMap and therefore falls to its
// BAD_REQUEST default.
const unimplementedError = () =>
    new QadamFlowError({
        code: ErrorCode.INVALID_APP_CONNECTION,
        params: {
            error: 'Platform-managed OAuth2 connections are not supported by this instance. Use an OAUTH2 connection with your own client credentials instead.',
        },
    })

const unimplementedService = (_log: FastifyBaseLogger): OAuth2Service<PlatformOAuth2ConnectionValue> => ({
    claim: async (
        _req: ClaimOAuth2Request,
    ): Promise<PlatformOAuth2ConnectionValue> => {
        throw unimplementedError()
    },
    refresh: async (
        _req: RefreshOAuth2Request<PlatformOAuth2ConnectionValue>,
    ): Promise<PlatformOAuth2ConnectionValue> => {
        throw unimplementedError()
    },
})

export const oauth2Handler = {
    [AppConnectionType.OAUTH2]: credentialsOauth2Service,
    [AppConnectionType.PLATFORM_OAUTH2]: unimplementedService,
}

export function setPlatformOAuthService(service: OAuth2Service<PlatformOAuth2ConnectionValue>) {
    oauth2Handler[AppConnectionType.PLATFORM_OAUTH2] = (_log: FastifyBaseLogger) => service
}

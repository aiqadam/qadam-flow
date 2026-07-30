import { AppConnectionType, ErrorCode, OAuth2GrantType, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { oauth2Handler } from '../../../../src/app/app-connection/app-connection-service/oauth2'

const log = {} as FastifyBaseLogger

// PLATFORM_OAUTH2 is accepted by the upsert request schema but nothing services it, so both
// operations must reject. What matters is HOW: a bare Error carries no statusCode, so the error
// handler answers 500 and reports to the exception handler — turning a predictable client input into
// a server fault plus alert noise. A QadamFlowError with a code absent from the handler's
// statusCodeMap falls to its BAD_REQUEST default instead.
describe('oauth2Handler[PLATFORM_OAUTH2]', () => {
    const service = oauth2Handler[AppConnectionType.PLATFORM_OAUTH2](log)

    it('rejects claim with a typed INVALID_APP_CONNECTION error', async () => {
        const error = await service
            .claim({
                projectId: 'test-project',
                platformId: 'test-platform',
                qadamName: 'test-qadam',
                request: {
                    grantType: OAuth2GrantType.AUTHORIZATION_CODE,
                    code: 'test-code',
                    tokenUrl: 'https://example.com/oauth/token',
                    clientId: 'test-client',
                    redirectUrl: 'https://example.com/redirect',
                },
            })
            .catch((e: unknown) => e)

        expect(error).toBeInstanceOf(QadamFlowError)
        if (error instanceof QadamFlowError) {
            expect(error.error.code).toBe(ErrorCode.INVALID_APP_CONNECTION)
        }
    })

    it('rejects refresh with a typed INVALID_APP_CONNECTION error', async () => {
        const error = await service
            .refresh({
                projectId: 'test-project',
                platformId: 'test-platform',
                qadamName: 'test-qadam',
                connectionValue: {
                    type: AppConnectionType.PLATFORM_OAUTH2,
                    client_id: 'test-client',
                    expires_in: 0,
                    claimed_at: 0,
                    access_token: 'test-token',
                    refresh_token: 'test-refresh-token',
                    token_url: 'https://example.com/oauth/token',
                    redirect_url: 'https://example.com/redirect',
                    scope: 'read',
                    token_type: 'bearer',
                    data: {},
                    props: {},
                },
            })
            .catch((e: unknown) => e)

        expect(error).toBeInstanceOf(QadamFlowError)
        if (error instanceof QadamFlowError) {
            expect(error.error.code).toBe(ErrorCode.INVALID_APP_CONNECTION)
        }
    })
})

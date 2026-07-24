import { API_KEY_PREFIX, isNil, Principal, PrincipalType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { apiKeyService } from '../../../../api-keys/api-key.service'
import { accessTokenManager } from '../../../../authentication/lib/access-token-manager'

export const authenticateOrThrow = async (log: FastifyBaseLogger, rawToken: string | null): Promise<Principal> => {
    if (!isNil(rawToken) && rawToken.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
        const value = rawToken.replace('Bearer ', '')
        const apiKey = await apiKeyService.getByValueOrThrow(value)
        return {
            id: apiKey.id,
            type: PrincipalType.SERVICE,
            platform: {
                id: apiKey.platformId,
            },
        }
    }
    if (!isNil(rawToken) && rawToken.startsWith('Bearer ')) {
        const trimBearerPrefix = rawToken.replace('Bearer ', '')
        return accessTokenManager(log).verifyPrincipal(trimBearerPrefix)
    }
    return {
        id: nanoid(),
        type: PrincipalType.UNKNOWN,
    }
}

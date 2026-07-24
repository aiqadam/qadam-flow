import { ApId, ApiKeyResponseWithValue, assertNotNullOrUndefined, CreateApiKeyRequest, PrincipalType, ResponseApiKey, SeekPage } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { apiKeyService } from './api-key.service'

export const apiKeyController: FastifyPluginAsyncZod = async (app) => {
    app.post('/', CreateApiKeyRequestSchema, async (req, res) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        const apiKey = await apiKeyService.create({
            platformId,
            request: req.body,
        })
        return res.status(StatusCodes.CREATED).send(apiKey)
    })

    app.get('/', ListApiKeysRequestSchema, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return apiKeyService.list({
            platformId,
            cursor: req.query.cursor,
            limit: req.query.limit,
        })
    })

    app.delete('/:id', DeleteApiKeyRequestSchema, async (req, res) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        await apiKeyService.delete({
            id: req.params.id,
            platformId,
        })
        return res.status(StatusCodes.NO_CONTENT).send()
    })
}

const CreateApiKeyRequestSchema = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        body: CreateApiKeyRequest,
        response: {
            [StatusCodes.CREATED]: ApiKeyResponseWithValue,
        },
    },
}

const ListApiKeysRequestSchema = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        querystring: z.object({
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: {
            [StatusCodes.OK]: SeekPage(ResponseApiKey),
        },
    },
}

const DeleteApiKeyRequestSchema = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        params: z.object({
            id: ApId,
        }),
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
    },
}

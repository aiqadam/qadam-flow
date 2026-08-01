import { AIProviderModel, AIProviderName, CreateAIProviderRequest, PrincipalType, UpdateAIProviderRequest } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { aiProviderService } from './ai-provider-service'

export const aiProviderController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListAIProviders, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).listProviders(platformId)
    })
    app.get('/:provider/config', GetAIProviderConfig, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).getConfigOrThrow({ platformId, provider: request.params.provider })
    })
    app.get('/:provider/models', ListModels, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).listModels(platformId, request.params.provider)
    })
    app.post('/', CreateAIProvider, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).create(platformId, request.body)
    })
    app.post('/:id', UpdateAIProvider, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).update(platformId, request.params.id, request.body)
    })
    app.delete('/:id', DeleteAIProvider, async (request, reply) => {
        const platformId = request.principal.platform.id
        await aiProviderService(app.log).delete(platformId, request.params.id)
        return reply.status(StatusCodes.NO_CONTENT).send()
    })
}

// Deliberately not admin-only: the builder's agent step settings render a model picker for any
// project member who can edit a flow (`packages/web/src/features/agents/ai-model/hooks.ts`), and
// it lists providers before listing that provider's models. The response carries no credentials —
// `auth` is decrypted only by the engine-only `/:provider/config` route. It does still carry each
// row's `config`, which for CUSTOM includes `baseUrl`, `apiKeyHeader` and `defaultHeaders`; that
// is a separate contract question (an integration test asserts it today) and is not changed here.
const ListAIProviders = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.ENGINE]),
    },
}

const GetAIProviderConfig = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        params: z.object({
            provider: z.nativeEnum(AIProviderName),
        }),
    },
}

// Same call site, same reasoning as ListAIProviders — the picker is useless without it.
const ListModels = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.ENGINE]),
    },
    schema: {
        params: z.object({
            provider: z.nativeEnum(AIProviderName),
        }),
        response: {
            [StatusCodes.OK]: z.array(AIProviderModel),
        },
    },
}

// Mutations are platform-admin only. `publicPlatform` is a principal-*type* check and nothing
// more (`authorize.ts`), so it let any authenticated user of the platform — including a read-only
// member of a single project — create, re-point or delete the platform's AI providers, and with
// `enabledForChat` that re-routes every chat turn on the platform through their endpoint. These
// routes are only reached from the platform-admin AI setup page.
const CreateAIProvider = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        body: CreateAIProviderRequest,
    },
}

const UpdateAIProvider = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
        body: UpdateAIProviderRequest,
    },
}

const DeleteAIProvider = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
    },
}

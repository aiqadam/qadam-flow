import { AIProviderModel, AIProviderName, ApId, CreateAIProviderRequest, PlatformRole, Principal, PrincipalType, UpdateAIProviderRequest } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { userService } from '../user/user-service'
import { aiProviderService } from './ai-provider-service'

export const aiProviderController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListAIProviders, async (request) => {
        const platformId = request.principal.platform.id
        const includeConfigSecrets = await isPrivilegedAIProviderReader({ principal: request.principal, log: app.log })
        return aiProviderService(app.log).listProviders({ platformId, includeConfigSecrets })
    })
    app.get('/:providerRef/config', GetAIProviderConfig, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).getConfigOrThrow({ platformId, ref: request.params.providerRef })
    })
    app.get('/:providerRef/models', ListModels, async (request) => {
        const platformId = request.principal.platform.id
        return aiProviderService(app.log).listModels({ platformId, ref: request.params.providerRef })
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

// A row id or a provider name. The two forms cannot collide — `apId()` draws 21 characters from
// `[0-9A-Za-z]` and the longest enum value is 18 characters, one of which contains a hyphen — and
// `ai-provider-ref.test.ts` asserts that, so the union is a real discriminator rather than an
// assumption. Validating it here turns a malformed ref into a 400 instead of a doomed lookup.
const ProviderRefSchema = z.union([z.enum(AIProviderName), ApId])

// A plain USER has no admin/role flag on the principal itself (`UserPrincipal` carries only
// `id`/`type`/`platform.id`) — the same reason `assertPlatformIsOwnedByCurrentPrincipal` in
// `authorize.ts` does a DB lookup for `platformAdminOnly` routes. ENGINE is always privileged here,
// same as the engine-only `/:providerRef/config` route, since it is the same class of internal
// caller (qadam props resolution, flow execution) rather than a platform member's own session.
async function isPrivilegedAIProviderReader({ principal, log }: { principal: Principal, log: FastifyBaseLogger }): Promise<boolean> {
    if (principal.type !== PrincipalType.USER) {
        return true
    }
    const user = await userService(log).getOneOrFail({ id: principal.id })
    return user.platformRole === PlatformRole.ADMIN
}

// Deliberately not admin-only: the builder's agent step settings render a model picker for any
// project member who can edit a flow (`packages/web/src/features/agents/ai-model/hooks.ts`), and
// it lists providers before listing that provider's models. The response carries no credentials —
// `auth` is decrypted only by the engine-only `/:providerRef/config` route. It does still carry each
// row's `config`, which for CUSTOM includes `baseUrl`, `apiKeyHeader`, `models` and `defaultHeaders`
// — of those, only `defaultHeaders` (an operator-defined record that commonly carries a second
// bearer/signing header) is actually credential-shaped, so `redactAIProviderConfig` strips it for
// any caller that is neither ENGINE nor a platform admin (#297). The other three fields stay because
// the model picker (`provider-options.ts`) and the qadam's own picker (`props.ts`) both read
// `baseUrl` off this exact response to disambiguate two rows of the same provider type.
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
            providerRef: ProviderRefSchema,
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
            providerRef: ProviderRefSchema,
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

import { LdapTestRequest, LdapTestResponse, PlatformLdapConfig, PrincipalType, UpsertLdapConfigRequest } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { ldapConfigService } from './ldap-config-service'

// Mirrors `ai-provider-controller.ts`'s per-platform singleton shape (GET / POST / DELETE, no id
// in the path) rather than `platform.controller.ts`'s `/v1/platforms/:id` nesting: like an AI
// provider row, this config is resolved off `request.principal.platform.id`, never off a path
// param, and — unlike AI providers, which a platform can hold several of per type — a platform
// holds at most one LDAP config, so there is no id to route on at all. `/test` sits under the same
// prefix as a sibling action rather than a fifth top-level route, the same way `ai-providers`
// nests `/:providerRef/models` under its own resource.
export const ldapConfigController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', GetLdapConfig, async (request) => {
        const platformId = request.principal.platform.id
        return ldapConfigService(app.log).get({ platformId })
    })

    app.post('/', UpsertLdapConfig, async (request) => {
        const platformId = request.principal.platform.id
        return ldapConfigService(app.log).upsert({ platformId, callingUserId: request.principal.id, request: request.body })
    })

    app.delete('/', DeleteLdapConfig, async (request, reply) => {
        const platformId = request.principal.platform.id
        await ldapConfigService(app.log).delete({ platformId })
        return reply.status(StatusCodes.NO_CONTENT).send()
    })

    app.post('/test', TestLdapConfig, async (request) => {
        const platformId = request.principal.platform.id
        return ldapConfigService(app.log).test({ platformId, request: request.body })
    })
}

const GetLdapConfig = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        response: {
            [StatusCodes.OK]: PlatformLdapConfig.nullable(),
        },
    },
}

const UpsertLdapConfig = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        body: UpsertLdapConfigRequest,
        response: {
            [StatusCodes.OK]: PlatformLdapConfig,
        },
    },
}

const DeleteLdapConfig = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
}

const TestLdapConfig = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        body: LdapTestRequest,
        response: {
            [StatusCodes.OK]: LdapTestResponse,
        },
    },
}

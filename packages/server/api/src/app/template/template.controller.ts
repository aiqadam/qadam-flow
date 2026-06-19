import {
    ALL_PRINCIPAL_TYPES,
    isNil,
    ListTemplatesRequestQuery,
    Principal,
    PrincipalType,
    SERVICE_KEY_SECURITY_OPENAPI,
    Template,
    TemplateType,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { platformService } from '../platform/platform.service'
import { communityTemplates } from './community-templates.service'
import { templateService } from './template.service'

export const templateController: FastifyPluginAsyncZod = async (app) => {
    app.get('/:id', GetParams, async (request) => {
        const template = await templateService(app.log).getOne({ id: request.params.id })
        if (!isNil(template)) {
            return template
        }
        return communityTemplates.getOrThrow(request.params.id)
    })

    app.get('/categories', GetCategoriesParams, async (_request) => {
        return communityTemplates.getCategories()
    })

    app.get('/', ListTemplatesParams, async (request) => {
        const officialTemplates = await loadOfficialTemplatesOrReturnEmpty(app.log, request.query)
        const customTemplates = await loadCustomTemplatesOrReturnEmpty(app.log, request.query, request.principal)

        return {
            data: [...officialTemplates, ...customTemplates],
            next: null,
            previous: null,
        }
    })

}

const GetIdParams = z.object({
    id: z.string(),
})
type GetIdParams = z.infer<typeof GetIdParams>

const GetCategoriesParams = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['templates'],
        description: 'Get categories of templates.',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
}

const GetParams = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        tags: ['templates'],
        description: 'Get a template.',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        params: GetIdParams,
    },
}

const ListTemplatesParams = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        tags: ['templates'],
        description: 'List templates.',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        querystring: ListTemplatesRequestQuery,
    },
}

async function loadOfficialTemplatesOrReturnEmpty(
    _log: FastifyBaseLogger,
    query: ListTemplatesRequestQuery,
): Promise<Template[]> {
    if (!isNil(query.type) && query.type !== TemplateType.OFFICIAL) {
        return []
    }
    const loadTemplatesFromCloud = await communityTemplates.list({ ...query, type: TemplateType.OFFICIAL })
    return loadTemplatesFromCloud.data
}

async function loadCustomTemplatesOrReturnEmpty(
    log: FastifyBaseLogger,
    query: ListTemplatesRequestQuery,
    principal: Principal,
): Promise<Template[]> {
    if ((!isNil(query.type) && query.type !== TemplateType.CUSTOM)) {
        return []
    }
    const platformId = principal.type === PrincipalType.UNKNOWN || principal.type === PrincipalType.WORKER || principal.type === PrincipalType.ONBOARDING ? null : principal.platform.id
    if (isNil(platformId)) {
        return []
    }
    const platform = await platformService(log).getOneWithPlanOrThrow(platformId)
    if (!platform.plan.manageTemplatesEnabled) {
        return []
    }
    const customTemplates = await templateService(log).list({ platformId, type: TemplateType.CUSTOM, ...query })
    return customTemplates.data
}
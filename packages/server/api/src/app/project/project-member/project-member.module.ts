import { ListProjectMembersParams, Permission, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { projectMemberService } from './project-member.service'

export const projectMemberModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(projectMemberController, { prefix: '/v1/project-members' })
}

const projectMemberController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListProjectMembersRequest, async (req) => {
        return projectMemberService(req.log).list({ projectId: req.query.projectId })
    })
}

const ListProjectMembersRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER], Permission.READ_PROJECT_MEMBER, {
            type: ProjectResourceType.QUERY,
        }),
    },
    schema: {
        querystring: ListProjectMembersParams,
    },
}

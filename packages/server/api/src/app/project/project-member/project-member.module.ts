import { GetProjectMemberRoleParams, ListProjectMembersParams, Permission, PrincipalType } from '@aiqadam/shared'
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

    // No `permission` is required here — unlike the list route above, this answers "what can the
    // caller do", so it must be reachable by every project member (including a VIEWER who holds no
    // Permission at all) rather than gated behind one. `securityAccess.project` still enforces that
    // the caller has *some* access to the project (membership, ownership, or platform privilege).
    app.get('/role', GetMyProjectRoleRequest, async (req) => {
        return projectMemberService(req.log).getMyRole({ projectId: req.projectId, userId: req.principal.id })
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

const GetMyProjectRoleRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER], undefined, {
            type: ProjectResourceType.QUERY,
        }),
    },
    schema: {
        querystring: GetProjectMemberRoleParams,
    },
}

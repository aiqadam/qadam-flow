import {
    ApId,
    GetProjectMemberRoleParams,
    ListProjectMemberCandidatesParams,
    ListProjectMembersParams,
    Permission,
    PrincipalType,
    ProjectMemberCandidate,
    ProjectMemberWithUser,
    UpdateProjectMemberRequestBody,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { ProjectMemberEntity } from '../project-member.entity'
import { projectMemberSideEffects } from './project-member-side-effects'
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

    app.get('/candidates', ListProjectMemberCandidatesRequest, async (req) => {
        return projectMemberService(req.log).listCandidates({
            platformId: req.principal.platform.id,
            projectId: req.query.projectId,
            search: req.query.search,
        })
    })

    app.post('/:id', UpdateProjectMemberRequest, async (req) => {
        return projectMemberService(req.log).update({
            projectId: req.projectId,
            memberId: req.params.id,
            actorUserId: req.principal.id,
            projectRole: req.body.projectRole,
        })
    })

    app.delete('/:id', RemoveProjectMemberRequest, async (req, res) => {
        const removedUserId = await projectMemberService(req.log).remove({
            projectId: req.projectId,
            memberId: req.params.id,
            actorUserId: req.principal.id,
        })
        projectMemberSideEffects.evictRemovedMember({ userId: removedUserId, projectId: req.projectId })
        return res.status(StatusCodes.NO_CONTENT).send()
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

const ListProjectMemberCandidatesRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER], Permission.WRITE_INVITATION, {
            type: ProjectResourceType.QUERY,
        }),
    },
    schema: {
        querystring: ListProjectMemberCandidatesParams,
        response: {
            [StatusCodes.OK]: z.array(ProjectMemberCandidate),
        },
    },
}

// `projectId` is resolved from the membership row itself (see `ProjectResourceType.TABLE`), so the
// permission is checked against the project the member actually belongs to, not one the caller
// names in the URL.
const UpdateProjectMemberRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER], Permission.WRITE_PROJECT_MEMBER, {
            type: ProjectResourceType.TABLE,
            tableName: ProjectMemberEntity,
        }),
    },
    schema: {
        params: z.object({
            id: ApId,
        }),
        body: UpdateProjectMemberRequestBody,
        response: {
            [StatusCodes.OK]: ProjectMemberWithUser,
        },
    },
}

const RemoveProjectMemberRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER], Permission.WRITE_PROJECT_MEMBER, {
            type: ProjectResourceType.TABLE,
            tableName: ProjectMemberEntity,
        }),
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

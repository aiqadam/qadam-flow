import { apId, ListProjectRequestForPlatformQueryParams, PrincipalType, Project, ProjectWithLimits, QadamsFilterType, SeekPage, UpdateProjectPlatformRequest } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { userService } from '../user/user-service'
import { projectService } from './project-service'

export const projectController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/:id', UpdateProjectRequest, async (request) => {
        const project = await projectService(request.log).getOneOrThrow(request.params.id)
        return toProjectWithLimits(
            await projectService(request.log).update(request.params.id, {
                type: project.type,
                ...request.body,
            }),
        )
    })

    fastify.get('/', ListProjectsRequest, async (request) => {
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        const projects = await projectService(request.log).getAllForUser({
            platformId: user.platformId!,
            userId: user.id,
            isPrivileged: userService(request.log).isUserPrivileged(user),
            displayName: request.query.displayName,
        })
        return paginationHelper.createPage(projects.map(toProjectWithLimits), null)
    })
}

function toProjectWithLimits(project: Project): ProjectWithLimits {
    const { deleted: _deleted, ...rest } = project
    return {
        ...rest,
        plan: {
            id: apId(),
            created: rest.created,
            updated: rest.updated,
            projectId: rest.id,
            locked: false,
            name: 'default',
            piecesFilterType: QadamsFilterType.NONE,
            pieces: [],
        },
        analytics: {
            totalUsers: 0,
            activeUsers: 0,
            totalFlows: 0,
            activeFlows: 0,
        },
    }
}

const UpdateProjectRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        tags: ['projects'],
        params: z.object({
            id: z.string(),
        }),
        response: {
            [StatusCodes.OK]: ProjectWithLimits,
        },
        body: UpdateProjectPlatformRequest,
    },
}

const ListProjectsRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
    schema: {
        tags: ['projects'],
        querystring: ListProjectRequestForPlatformQueryParams,
        response: {
            [StatusCodes.OK]: SeekPage(ProjectWithLimits),
        },
    },
}

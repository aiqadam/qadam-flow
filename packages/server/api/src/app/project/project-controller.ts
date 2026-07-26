import { apId, CreatePlatformProjectRequest, ListProjectRequestForPlatformQueryParams, PrincipalType, Project, ProjectType, ProjectWithLimits, QadamsFilterType, SeekPage, UpdateProjectPlatformRequest } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { userService } from '../user/user-service'
import { projectService } from './project-service'
import { projectSideEffects } from './project-side-effects'

export const projectController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.post('/', CreateProjectRequest, async (request, reply) => {
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        const project = await projectService(request.log).create({
            displayName: request.body.displayName,
            ownerId: user.id,
            platformId: user.platformId!,
            type: ProjectType.TEAM,
            externalId: request.body.externalId ?? undefined,
            metadata: request.body.metadata ?? undefined,
            maxConcurrentJobs: request.body.maxConcurrentJobs ?? undefined,
        })
        return reply.status(StatusCodes.CREATED).send(toProjectWithLimits(project))
    })

    fastify.post('/:id', UpdateProjectRequest, async (request) => {
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        const project = await projectService(request.log).getOneOrThrow(request.params.id)
        return toProjectWithLimits(
            await projectService(request.log).update({
                projectId: request.params.id,
                platformId: user.platformId!,
                userId: user.id,
                isPrivileged: userService(request.log).isUserPrivileged(user),
                request: {
                    type: project.type,
                    ...request.body,
                },
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

    fastify.delete('/:id', DeleteProjectRequest, async (request, reply) => {
        const user = await userService(request.log).getOneOrFail({ id: request.principal.id })
        await projectService(request.log).softDelete({
            projectId: request.params.id,
            platformId: user.platformId!,
            userId: user.id,
            isPrivileged: userService(request.log).isUserPrivileged(user),
        })
        await projectSideEffects(request.log).postSoftDelete({ projectId: request.params.id })
        return reply.status(StatusCodes.NO_CONTENT).send()
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

const CreateProjectRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
    schema: {
        tags: ['projects'],
        body: CreatePlatformProjectRequest,
        response: {
            [StatusCodes.CREATED]: ProjectWithLimits,
        },
    },
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

const DeleteProjectRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
    schema: {
        tags: ['projects'],
        params: z.object({
            id: z.string(),
        }),
        response: {
            [StatusCodes.NO_CONTENT]: z.undefined(),
        },
    },
}

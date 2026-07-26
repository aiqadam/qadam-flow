import {
    assertNotNullOrUndefined,
    ErrorCode,
    InvitationStatus,
    InvitationType,
    isNil,
    ListUserInvitationsRequest,
    Permission,
    PlatformRole,
    Principal,
    PrincipalType,
    QadamFlowError,
    SeekPage,
    SendUserInvitationRequest,
    SERVICE_KEY_SECURITY_OPENAPI,
    UserInvitation,
    UserInvitationWithLink,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { ProjectRoleEntity } from '../project/project-role.entity'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { userInvitationsService } from './user-invitation.service'

const projectRoleRepo = repoFactory(ProjectRoleEntity)

export const invitationModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(invitationController, { prefix: '/v1/user-invitations' })
}

const invitationController: FastifyPluginAsyncZod = async (app) => {

    app.post('/', UpsertUserInvitationRequestParams, async (request, reply) => {
        const { email, type } = request.body
        if (type === InvitationType.PROJECT) {
            await assertPrincipalHasPermissionToProject(request, request.principal, request.body.projectId)
        }
        else {
            await assertPrincipalIsPlatformAdmin(request, request.principal)
        }
        const platformId = request.principal.platform.id
        const status = await shouldAutoAcceptInvitation(request.principal, request.body, platformId, request.log) ? InvitationStatus.ACCEPTED : InvitationStatus.PENDING

        const projectRoleId = type === InvitationType.PROJECT && request.body.projectRole
            ? (await projectRoleRepo().findOneByOrFail({ name: request.body.projectRole, platformId })).id
            : null

        const invitation = await userInvitationsService(request.log).create({
            email,
            type,
            platformId,
            platformRole: type === InvitationType.PROJECT ? null : request.body.platformRole,
            projectId: type === InvitationType.PLATFORM ? null : request.body.projectId,
            projectRoleId,
            invitationExpirySeconds: dayjs.duration(7, 'days').asSeconds(),
            status,
        })
        await reply.status(StatusCodes.CREATED).send(invitation)
    })

    app.get('/', ListUserInvitationsRequestParams, async (request, reply) => {
        const projectId = await getProjectIdAndAssertPermission(request, request.principal, request.query)
        const invitations = await userInvitationsService(request.log).list({
            platformId: request.principal.platform.id,
            projectId: request.query.type === InvitationType.PROJECT ? projectId : null,
            type: request.query.type,
            status: request.query.status,
            cursor: request.query.cursor ?? null,
            limit: request.query.limit ?? 10,
        })
        await reply.status(StatusCodes.OK).send(invitations)
    })

    app.post('/accept', AcceptUserInvitationRequestParams, async (request, reply) => {
        const invitation = await userInvitationsService(request.log).getOneByInvitationTokenOrThrow(request.body.invitationToken)
        await userInvitationsService(request.log).accept({
            invitationId: invitation.id,
            platformId: invitation.platformId,
        })
        await reply.status(StatusCodes.OK).send(invitation)
    })

    app.delete('/:id', DeleteInvitationRequestParams, async (request, reply) => {
        const invitation = await userInvitationsService(request.log).getOneOrThrow({
            id: request.params.id,
            platformId: request.principal.platform.id,
        })
        if (invitation.type === InvitationType.PROJECT) {
            assertNotNullOrUndefined(invitation.projectId, 'projectId')
            await assertPrincipalHasPermissionToProject(request, request.principal, invitation.projectId)
        }
        await userInvitationsService(request.log).delete({
            id: request.params.id,
            platformId: request.principal.platform.id,
        })
        await reply.status(StatusCodes.NO_CONTENT).send()
    })
}


async function getProjectIdAndAssertPermission<R extends Principal & { platform: { id: string } }>(
    request: FastifyRequest,
    principal: R,
    requestQuery: ListUserInvitationsRequest,
): Promise<string | null> {
    if (requestQuery.type === InvitationType.PLATFORM) {
        await assertPrincipalCanListPlatformInvitations(request, principal)
        return null
    }
    if (isNil(requestQuery.projectId)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: { message: 'projectId is required for project-scoped invitation list' },
        })
    }
    await assertPrincipalHasPermissionToProject(request, principal, requestQuery.projectId)
    return requestQuery.projectId
}

async function assertPrincipalCanListPlatformInvitations(request: FastifyRequest, principal: Principal): Promise<void> {
    if (principal.type !== PrincipalType.USER) {
        return
    }
    const user = await userService(request.log).getOneOrFail({ id: principal.id })
    if (!userService(request.log).isUserPrivileged(user)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: { userId: user.id, message: 'user is not authorized to list platform-scope invitations' },
        })
    }
}

// Creating a platform invitation mints a platform role on acceptance, so it is
// gated to platform ADMIN — matching POST /v1/users/:id (platformAdminOnly),
// which rejects OPERATOR. SERVICE (API key) is platform-scoped admin.
async function assertPrincipalIsPlatformAdmin(request: FastifyRequest, principal: Principal): Promise<void> {
    if (principal.type !== PrincipalType.USER) {
        return
    }
    const user = await userService(request.log).getOneOrFail({ id: principal.id })
    if (user.platformRole !== PlatformRole.ADMIN) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: { userId: user.id, message: 'user is not authorized to create a platform-scope invitation' },
        })
    }
}

async function shouldAutoAcceptInvitation(principal: Principal, request: SendUserInvitationRequest, platformId: string, log: FastifyBaseLogger): Promise<boolean> {
    if (principal.type === PrincipalType.SERVICE) {
        return true
    }

    if (request.type === InvitationType.PLATFORM) {
        return false
    }

    const identity = await userIdentityService(log).getIdentityByEmail(request.email)
    if (isNil(identity)) {
        return false
    }

    const user = await userService(log).getOneByIdentityAndPlatform({
        identityId: identity.id,
        platformId,
    })
    return !isNil(user)
}

async function assertPrincipalHasPermissionToProject<R extends Principal & { platform: { id: string } }>(
    request: FastifyRequest, principal: R,
    projectId: string): Promise<void> {
    const project = await projectService(request.log).getOneOrThrow(projectId)
    if (isNil(project) || project.platformId !== principal.platform.id) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'user does not have access to the project',
            },
        })
    }
    // SERVICE principals are api-key based and treated as platform-scoped admin.
    if (principal.type === PrincipalType.SERVICE) {
        return
    }
    if (principal.type !== PrincipalType.USER) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: { message: 'principal cannot manage invitations for this project' },
        })
    }
    const user = await userService(request.log).getOneOrFail({ id: principal.id })
    if (userService(request.log).isUserPrivileged(user)) {
        return
    }
    if (project.ownerId === user.id) {
        return
    }
    const role = await projectService(request.log).getProjectRoleForUser({
        userId: user.id,
        projectId: project.id,
        platformId: project.platformId,
    })
    if (isNil(role) || !role.permissions.includes(Permission.WRITE_INVITATION)) {
        throw new QadamFlowError({
            code: ErrorCode.PERMISSION_DENIED,
            params: {
                userId: user.id,
                projectId: project.id,
                projectRole: role,
                permission: Permission.WRITE_INVITATION,
            },
        })
    }
}


const ListUserInvitationsRequestParams = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE], {
            type: ProjectResourceType.QUERY,
            queryKey: 'projectId',
        }),
    },
    schema: {
        tags: ['user-invitations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        querystring: ListUserInvitationsRequest,
        response: {
            [StatusCodes.OK]: SeekPage(UserInvitation),
        },
    },
}

const AcceptUserInvitationRequestParams = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        body: z.object({
            invitationToken: z.string(),
        }),
    },
}

const DeleteInvitationRequestParams = {
    config: {
        security: securityAccess.unscoped([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        tags: ['user-invitations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        params: z.object({
            id: z.string(),
        }),
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
    },
}

const UpsertUserInvitationRequestParams = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER, PrincipalType.SERVICE], {
            type: ProjectResourceType.BODY,
        }),
        rateLimit: {
            max: Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX), 10),
            timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
        },
    },
    schema: {
        body: SendUserInvitationRequest,
        description: 'Send a user invitation to a user. If the user already has an invitation, the invitation will be updated.',
        tags: ['user-invitations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        response: {
            [StatusCodes.CREATED]: UserInvitationWithLink,
        },
    },
}

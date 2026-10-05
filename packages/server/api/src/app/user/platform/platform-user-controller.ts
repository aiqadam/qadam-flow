import {
    ApId,
    assertNotNullOrUndefined,
    ListUsersRequestBody,
    PlatformRole,
    PrincipalType,
    SeekPage,
    SERVICE_KEY_SECURITY_OPENAPI,
    UpdateUserRequestBody,
    UserWithBadges,
    UserWithMetaInformation,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { websocketService } from '../../core/websockets.service'
import { projectService } from '../../project/project-service'
import { userService } from '../user-service'

export const platformUserController: FastifyPluginAsyncZod = async (app) => {

    app.get('/me', GetCurrentUserRequest, async (req) => {
        // ONBOARDING principals exist between sign-up and platform creation and are never
        // platform-scoped (see OnboardingPrincipal in principal.ts). Their principal.id is the
        // identity id, not a user id (getOnboardingResponse in authentication-utils.ts) — looking
        // it up is safe because that id always comes from the caller's own token, never input.
        if (req.principal.type === PrincipalType.ONBOARDING) {
            return userService(req.log).getOneByIdentityForOnboardingOrThrow({ identityId: req.principal.id })
        }

        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return userService(req.log).getOneByIdAndPlatformIdOrThrow({
            id: req.principal.id,
            platformId,
        })
    })

    app.get('/:id', GetUserRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return userService(req.log).getOneByIdAndPlatformIdOrThrow({
            id: req.params.id,
            platformId,
        })
    })

    app.get('/', ListUsersRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        return userService(req.log).list({
            platformId,
            externalId: req.query.externalId,
            cursorRequest: req.query.cursor ?? null,
            limit: req.query.limit ?? 10,
        })
    })

    app.post('/:id', UpdateUserRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        const before = await userService(req.log).getOrThrow({ id: req.params.id })
        const updated = await userService(req.log).update({
            id: req.params.id,
            platformId,
            platformRole: req.body.platformRole,
            status: req.body.status,
            externalId: req.body.externalId,
        })
        // A role change that removes the privileged bypass, or a status change, can take away this
        // user's access to project rooms they are not a member of — evict so broadcasts stop
        // immediately. Compared before/after so a promotion or an unrelated save does not
        // spuriously drop a still-authorized socket.
        const wasPrivileged = before.platformRole === PlatformRole.ADMIN || before.platformRole === PlatformRole.OPERATOR
        const isPrivileged = updated.platformRole === PlatformRole.ADMIN || updated.platformRole === PlatformRole.OPERATOR
        if ((wasPrivileged && !isPrivileged) || before.status !== updated.status) {
            const projectIds = await projectService(req.log).getProjectIdsByPlatform(platformId)
            websocketService.evictUserFromProjects({ userId: req.params.id, projectIds })
        }
        return updated
    })

    app.delete('/:id', DeleteUserRequest, async (req, res) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        await userService(req.log).delete({
            id: req.params.id,
            platformId,
        })
        // A removed user's sockets would otherwise keep receiving project broadcasts until their
        // next event; drop them from every project room of this platform now.
        const projectIds = await projectService(req.log).getProjectIdsByPlatform(platformId)
        websocketService.evictUserFromProjects({ userId: req.params.id, projectIds })

        return res.status(StatusCodes.NO_CONTENT).send()
    })
}

const GetCurrentUserRequest = {
    schema: {
        response: {
            [StatusCodes.OK]: UserWithBadges,
        },
        tags: ['users'],
        description: 'Get the current user',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.unscoped([PrincipalType.USER, PrincipalType.SERVICE, PrincipalType.ONBOARDING]),
    },
}

const GetUserRequest = {
    schema: {
        params: z.object({
            id: ApId,
        }),
        response: {
            [StatusCodes.OK]: UserWithBadges,
        },
        tags: ['users'],
        description: 'Get user by id',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

const ListUsersRequest = {
    schema: {
        querystring: ListUsersRequestBody,
        response: {
            [StatusCodes.OK]: SeekPage(UserWithMetaInformation),
        },
        tags: ['users'],
        description: 'List users',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    response: {
        [StatusCodes.OK]: SeekPage(UserWithMetaInformation),
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

const UpdateUserRequest = {
    schema: {
        params: z.object({
            id: ApId,
        }),
        body: UpdateUserRequestBody,
        response: {
            [StatusCodes.OK]: UserWithMetaInformation,
        },
        tags: ['users'],
        description: 'Update user',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

const DeleteUserRequest = {
    schema: {
        params: z.object({
            id: ApId,
        }),
        tags: ['users'],
        description: 'Delete user',
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
        security: [SERVICE_KEY_SECURITY_OPENAPI],
    },
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
}

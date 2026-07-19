import { ErrorCode, isNil, PlatformRole, Principal, PrincipalType, ProjectType, QadamFlowError, UserIdentityProvider } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { userIdentityService } from '../../../../authentication/user-identity/user-identity-service'
import { projectService } from '../../../../project/project-service'
import { userService } from '../../../../user/user-service'
import { AuthorizationRouteSecurity, ProjectAuthorizationConfig } from '../../authorization/authorization'
import { AuthorizationType, RouteKind } from '../../authorization/common'

export const authorizeOrThrow = async (principal: Principal, security: AuthorizationRouteSecurity, log: FastifyBaseLogger): Promise<void> => {
    if (security.kind === RouteKind.PUBLIC) {
        return
    }
    switch (security.authorization.type) {
        case AuthorizationType.PROJECT:
            await assertPrinicpalIsOneOf(security.authorization.allowedPrincipals, principal.type)
            await assertAccessToProject(principal, security.authorization, log)
            break
        case AuthorizationType.PLATFORM:
            await assertPrinicpalIsOneOf(security.authorization.allowedPrincipals, principal.type)
            if (security.authorization.adminOnly) {
                await assertPlatformIsOwnedByCurrentPrincipal(principal, log)
            }
            if (security.authorization.nonEmbedUsersOnly) {
                await assertNonEmbedOrAdmin(principal, log)
            }
            break
        case AuthorizationType.UNSCOPED:
            await assertPrinicpalIsOneOf(security.authorization.allowedPrincipals, principal.type)
            break
        case AuthorizationType.NONE:
            break
    }
}


async function assertNonEmbedOrAdmin(principal: Principal, log: FastifyBaseLogger): Promise<void> {
    if (principal.type === PrincipalType.SERVICE) {
        return
    }
    const user = await userService(log).getOneOrFail({ id: principal.id })
    if (user.platformRole === PlatformRole.ADMIN) {
        return
    }
    const identity = await userIdentityService(log).getOneOrFail({ id: user.identityId })
    if (identity.provider === UserIdentityProvider.JWT) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'Embed users are not allowed to access this resource.',
            },
        })
    }
    if (isNil(user.platformId)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not associated with a platform.',
            },
        })
    }
}

async function assertPlatformIsOwnedByCurrentPrincipal(principal: Principal, log: FastifyBaseLogger): Promise<void> {
    if (principal.type === PrincipalType.SERVICE) {
        return
    }
    const user = await userService(log).getOneOrFail({ id: principal.id })
    if (user.platformRole !== PlatformRole.ADMIN) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not an admin/owner of the platform.',
            },
        })
    }
}


async function assertAccessToProject(principal: Principal, projectSecurity: ProjectAuthorizationConfig, log: FastifyBaseLogger): Promise<void> {
    if (isNil(projectSecurity.projectId)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'Project ID is required',
            },
        })
    }
    if ('projectId' in principal && principal.projectId === projectSecurity.projectId) {
        return
    }

    if (principal.type !== PrincipalType.USER && principal.type !== PrincipalType.SERVICE) {
        throwNoAccess()
    }

    const user = await userService(log).getOneOrFail({ id: principal.id })
    if (isNil(user.platformId)) {
        throwNoAccess()
    }

    const project = await projectService(log).getOne(projectSecurity.projectId)
    if (isNil(project) || project.platformId !== user.platformId) {
        throwNoAccess()
    }

    // SERVICE principals are api-key based and treated as platform-scoped admin.
    // They bypass per-project membership and permission checks.
    if (principal.type === PrincipalType.SERVICE) {
        return
    }

    // Platform-privileged users (ADMIN/OPERATOR) bypass per-project checks.
    if (userService(log).isUserPrivileged(user)) {
        return
    }

    if (project.type === ProjectType.PERSONAL) {
        if (project.ownerId === user.id) {
            return
        }
        throwNoAccess()
    }

    const role = await projectService(log).getProjectRoleForUser({
        userId: user.id,
        projectId: project.id,
        platformId: project.platformId,
    })
    if (isNil(role)) {
        throwNoAccess()
    }

    if (!isNil(projectSecurity.permission) && !role.permissions.includes(projectSecurity.permission)) {
        throw new QadamFlowError({
            code: ErrorCode.PERMISSION_DENIED,
            params: {
                userId: user.id,
                projectId: project.id,
                projectRole: role,
                permission: projectSecurity.permission,
            },
        })
    }
}

function throwNoAccess(): never {
    throw new QadamFlowError({
        code: ErrorCode.AUTHORIZATION,
        params: {
            message: 'Principal does not have access to this project',
        },
    })
}


async function assertPrinicpalIsOneOf< T extends readonly PrincipalType[]>(allowedPrincipals: T, currentPrincipal: PrincipalType): Promise<void> {
    if (!allowedPrincipals.includes(currentPrincipal)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'principal is not allowed for this route',
            },
        })
    }
}
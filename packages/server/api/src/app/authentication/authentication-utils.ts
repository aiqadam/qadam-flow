import { assertNotNullOrUndefined, AuthenticationResponse, EndpointScope, ErrorCode, isNil, PlatformRole, PrincipalType, Project, ProjectType, QadamFlowError, TelemetryEventName, User, UserIdentity, UserIdentityProvider, UserStatus } from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { telemetry } from '../helper/telemetry.utils'
import { platformService } from '../platform/platform.service'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { userInvitationsService } from '../user-invitations/user-invitation.service'
import { accessTokenManager } from './lib/access-token-manager'
import { userIdentityService } from './user-identity/user-identity-service'

export const authenticationUtils = (log: FastifyBaseLogger) => ({
    async assertUserIsInvitedToPlatformOrProject({
        email,
        platformId,
    }: AssertUserIsInvitedToPlatformOrProjectParams): Promise<void> {
        const isInvited = await userInvitationsService(log).hasAnyAcceptedInvitations({
            platformId,
            email,

        })
        if (!isInvited) {
            throw new QadamFlowError({
                code: ErrorCode.INVITATION_ONLY_SIGN_UP,
                params: {
                    message: 'User is not invited to the platform',
                },
            })
        }
    },

    async getProjectAndToken(params: GetProjectAndTokenParams): Promise<AuthenticationResponse> {
        const user = await userService(log).getOneOrFail({ id: params.userId })
        const projects = await projectService(log).getAllForUser({
            platformId: params.platformId,
            userId: params.userId,
            isPrivileged: userService(log).isUserPrivileged(user),
        })
        const project = isNil(params.projectId)
            ? findPersonalProject(projects, params.userId) ?? projects?.[0]
            : projects.find((project) => project.id === params.projectId)
        if (isNil(project)) {
            throw new QadamFlowError({
                code: ErrorCode.INVITATION_ONLY_SIGN_UP,
                params: {
                    message: 'No project found for user',
                },
            })
        }
        const identity = await userIdentityService(log).getOneOrFail({ id: user.identityId })
        if (!identity.verified) {
            throw new QadamFlowError({
                code: ErrorCode.EMAIL_IS_NOT_VERIFIED,
                params: {
                    email: identity.email,
                },
            })
        }
        if (user.status === UserStatus.INACTIVE) {
            throw new QadamFlowError({
                code: ErrorCode.USER_IS_INACTIVE,
                params: {
                    email: identity.email,
                },
            })
        }
        const token = await accessTokenManager(log).generateToken({
            id: user.id,
            type: PrincipalType.USER,
            platform: {
                id: params.platformId,
            },
            tokenVersion: identity.tokenVersion,
        })
        return {
            ...user,
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: identity.email,
            trackEvents: identity.trackEvents,
            newsLetter: identity.newsLetter,
            verified: identity.verified,
            token,
            projectId: project.id,
        }
    },

    async getOnboardingResponse({ identityId }: GetOnboardingResponseParams): Promise<AuthenticationResponse> {
        const identity = await userIdentityService(log).getOneOrFail({ id: identityId })
        if (!identity.verified) {
            throw new QadamFlowError({
                code: ErrorCode.EMAIL_IS_NOT_VERIFIED,
                params: {
                    email: identity.email,
                },
            })
        }

        const token = await accessTokenManager(log).generateToken({
            id: identity.id,
            type: PrincipalType.ONBOARDING,
            tokenVersion: identity.tokenVersion,
        })
        return {
            id: identity.id,
            platformId: null,
            platformRole: PlatformRole.ADMIN,
            status: UserStatus.ACTIVE,
            externalId: null,
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: identity.email,
            trackEvents: identity.trackEvents,
            newsLetter: identity.newsLetter,
            verified: identity.verified,
            token,
            projectId: null,
        }
    },

    async assertDomainIsAllowed({
        email,
        platformId,
    }: AssertDomainIsAllowedParams): Promise<void> {
        const platform = await platformService(log).getOneWithPlanOrThrow(platformId)
        if (!platform.plan.ssoEnabled) {
            return
        }
        const emailDomain = email.split('@')[1]
        const isAllowedDomaiin =
            !platform.enforceAllowedAuthDomains ||
            platform.allowedAuthDomains.includes(emailDomain)

        if (!isAllowedDomaiin) {
            throw new QadamFlowError({
                code: ErrorCode.DOMAIN_NOT_ALLOWED,
                params: {
                    domain: emailDomain,
                },
            })
        }
    },

    async assertEmailMatchesSsoDomain(
        _params: AssertEmailMatchesSsoDomainParams,
    ): Promise<void> {
        return
    },

    async assertEmailAuthIsEnabled({
        platformId,
        provider,
    }: AssertEmailAuthIsEnabledParams): Promise<void> {
        const platform = await platformService(log).getOneWithPlanOrThrow(platformId)
        if (!platform.plan.ssoEnabled) {
            return
        }
        if (provider !== UserIdentityProvider.EMAIL) {
            return
        }
        if (!platform.emailAuthEnabled) {
            throw new QadamFlowError({
                code: ErrorCode.EMAIL_AUTH_DISABLED,
                params: {},
            })
        }
    },

    async sendTelemetry({
        user,
        identity,
        projectId,
    }: SendTelemetryParams): Promise<void> {
        try {
            const { email, firstName, lastName } = identity
            await telemetry(log).identify(identity, user)
            await telemetry(log).trackProject(projectId, {
                name: TelemetryEventName.SIGNED_UP,
                payload: { userId: user.id, email, firstName, lastName, projectId },
            })
        }
        catch (e) {
            log.warn({ err: e }, '[authenticationUtils#sendTelemetry] Failed to send telemetry')
        }
    },

    async saveNewsLetterSubscriber(_identity: UserIdentity): Promise<void> {
        return
    },
    async extractUserIdFromRequest(request: FastifyRequest): Promise<string> {
        if (request.principal.type === PrincipalType.USER) {
            return request.principal.id
        }
        // TODO currently it's same as api service, but it's better to get it from api key service, in case we introduced more admin users
        const projectId = request.principal.type === PrincipalType.ENGINE ? request.principal.projectId : request.projectId
        assertNotNullOrUndefined(projectId, 'projectId')
        const project = await projectService(log).getOneOrThrow(projectId)
        return project.ownerId
    },
})

function findPersonalProject(projects: Project[], userId: string): Project | undefined {
    return projects.find((project) => project.ownerId === userId && project.type === ProjectType.PERSONAL)
}

type SendTelemetryParams = {
    identity: UserIdentity
    user: User
    projectId: string
}

type AssertDomainIsAllowedParams = {
    email: string
    platformId: string
}

type AssertEmailAuthIsEnabledParams = {
    platformId: string
    provider: UserIdentityProvider
}

type AssertEmailMatchesSsoDomainParams = {
    email: string
    platformId: string
}

type AssertUserIsInvitedToPlatformOrProjectParams = {
    email: string
    platformId: string
}

type GetOnboardingResponseParams = {
    identityId: string
}

type GetProjectAndTokenParams = {
    userId: string
    platformId: string
    projectId: string | null
    scope?: EndpointScope
}

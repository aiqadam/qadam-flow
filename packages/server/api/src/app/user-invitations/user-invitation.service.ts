import { apId, assertNotNullOrUndefined, ErrorCode, FederatedIdentityProvider, InvitationStatus, InvitationType, isNil, PlatformRole, QadamFlowError, SeekPage, spreadIfDefined, tryCatch, UserIdentity, UserIdentityProvider, UserInvitation, UserInvitationWithLink } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull } from 'typeorm'
import { userFederatedIdentityService } from '../authentication/federated-identity/user-federated-identity-service'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { domainHelper } from '../helper/domain-helper'
import { JwtAudience, jwtUtils } from '../helper/jwt-utils'
import { emailService } from '../helper/mail/email-service'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { platformService } from '../platform/platform.service'
import { ProjectMemberEntity } from '../project/project-member.entity'
import { ProjectRoleEntity } from '../project/project-role.entity'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { UserInvitationEntity } from './user-invitation.entity'

const repo = repoFactory(UserInvitationEntity)
const projectMemberRepo = repoFactory(ProjectMemberEntity)
const projectRoleRepo = repoFactory(ProjectRoleEntity)

export const userInvitationsService = (log: FastifyBaseLogger) => ({
    async getOneByInvitationTokenOrThrow(invitationToken: string): Promise<UserInvitation> {
        const jwtSecret = await jwtUtils.getJwtSecret()
        const { data: decodedToken, error } = await tryCatch(() => jwtUtils.decodeAndVerify<UserInvitationToken>({
            jwt: invitationToken,
            key: jwtSecret,
            audience: JwtAudience.USER_INVITATION,
        }))
        if (error) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: 'invalid-token',
                    entityType: 'UserInvitation',
                },
            })
        }
        const invitation = await repo().findOneBy({
            id: decodedToken.id,
        })
        if (isNil(invitation)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: `id=${decodedToken.id}`,
                    entityType: 'UserInvitation',
                },
            })
        }
        return invitation
    },
    async provisionUserInvitation({ email }: ProvisionUserInvitationParams): Promise<void> {
        const invitations = await repo().createQueryBuilder('user_invitation')
            .where('LOWER("user_invitation"."email") = :email', { email: email.toLowerCase().trim() })
            .andWhere({
                status: InvitationStatus.ACCEPTED,
            })
            .getMany()

        if (invitations.length === 0) return

        const identity = await userIdentityService(log).getIdentityByEmail(email)
        if (isNil(identity)) return

        log.info({ count: invitations.length }, '[provisionUserInvitation] list invitations')
        for (const invitation of invitations) {
            if (!(await isEligibleForInvitationProvisioning({ identity, platformId: invitation.platformId, log }))) {
                log.warn(
                    { invitationId: invitation.id, platformId: invitation.platformId, identityId: identity.id },
                    '[provisionUserInvitation] Refusing to grant platform/project access to a directory-authenticated '
                    + 'identity with no federated row on this platform — it must sign in through this platform\'s own '
                    + 'directory instead',
                )
                continue
            }
            log.info({ invitation }, '[provisionUserInvitation] provision')
            const user = await userService(log).getOrCreateWithProject({
                identity,
                platformId: invitation.platformId,
            })
            switch (invitation.type) {
                case InvitationType.PLATFORM: {
                    assertNotNullOrUndefined(invitation.platformRole, 'platformRole')
                    await userService(log).update({
                        id: user.id,
                        platformId: invitation.platformId,
                        platformRole: invitation.platformRole,
                    })
                    break
                }
                case InvitationType.PROJECT: {
                    assertNotNullOrUndefined(invitation.projectId, 'projectId')
                    assertNotNullOrUndefined(invitation.projectRoleId, 'projectRoleId')
                    await projectMemberRepo().upsert({
                        id: apId(),
                        userId: user.id,
                        projectId: invitation.projectId,
                        projectRoleId: invitation.projectRoleId,
                        platformId: invitation.platformId,
                    }, ['userId', 'projectId'])
                    await sendProjectMemberAddedEmail({ invitation, log })
                    break
                }
            }
            await repo().delete({
                id: invitation.id,
            })
        }
    },
    async create({
        email,
        platformId,
        projectId,
        type,
        projectRoleId,
        platformRole,
        invitationExpirySeconds,
        status,
    }: CreateParams): Promise<UserInvitationWithLink> {
        const id = apId()
        await repo().upsert({
            id,
            status,
            type,
            email: email.toLowerCase().trim(),
            platformId,
            projectRoleId: type === InvitationType.PLATFORM ? undefined : projectRoleId!,
            platformRole: type === InvitationType.PROJECT ? undefined : platformRole!,
            projectId: type === InvitationType.PLATFORM ? undefined : projectId!,
        }, ['email', 'platformId', 'projectId'])

        const userInvitation = await this.getOneOrThrow({
            id,
            platformId,
        })
        if (status === InvitationStatus.ACCEPTED) {
            await this.accept({
                invitationId: id,
                platformId,
            })
            return userInvitation
        }
        const enrichedInvitation = await enrichWithInvitationLink(userInvitation, invitationExpirySeconds)
        await sendInvitationEmail({ userInvitation, invitationLink: enrichedInvitation.link, log })
        return enrichedInvitation
    },
    async list(params: ListUserParams): Promise<SeekPage<UserInvitation>> {
        const decodedCursor = paginationHelper.decodeCursor(params.cursor ?? null)
        const paginator = buildPaginator({
            entity: UserInvitationEntity,
            query: {
                limit: params.limit,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const queryBuilder = repo().createQueryBuilder('user_invitation')
            .where({
                platformId: params.platformId,
                ...spreadIfDefined('projectId', params.projectId),
                ...spreadIfDefined('status', params.status),
                ...spreadIfDefined('type', params.type),
            })
        const { data, cursor } = await paginator.paginate(queryBuilder)
        const enrichedData = data.map((invitation) => ({
            projectRole: null,
            ...invitation,
        }))
        return paginationHelper.createPage<UserInvitation>(enrichedData, cursor)
    },
    async delete({ id, platformId }: PlatformAndIdParams): Promise<void> {
        const invitation = await this.getOneOrThrow({ id, platformId })
        await repo().delete({
            id: invitation.id,
            platformId,
        })
    },
    async getOneOrThrow({ id, platformId }: PlatformAndIdParams): Promise<UserInvitation> {
        const invitation = await repo().findOne({
            where: {
                id,
                platformId,
            },
        })
        if (isNil(invitation)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: `id=${id}`,
                    entityType: 'UserInvitation',
                },
            })
        }
        return invitation
    },
    async accept({ invitationId, platformId }: AcceptParams): Promise<void> {
        const invitation = await this.getOneOrThrow({ id: invitationId, platformId })
        await repo().update(invitation.id, {
            status: InvitationStatus.ACCEPTED,
        })
        const identity = await userIdentityService(log).getIdentityByEmail(invitation.email)
        if (isNil(identity)) {
            return
        }
        await this.provisionUserInvitation({
            email: invitation.email,
        })
    },
    async hasAnyAcceptedInvitationsForEmail({ email }: { email: string }): Promise<boolean> {
        const count = await repo().createQueryBuilder('user_invitation')
            .where('LOWER("user_invitation"."email") = :email', { email: email.toLowerCase().trim() })
            .andWhere({ status: InvitationStatus.ACCEPTED })
            .getCount()
        return count > 0
    },
    async hasAnyAcceptedInvitations({
        email,
        platformId,
    }: HasAnyAcceptedInvitationsParams): Promise<boolean> {
        const invitations = await repo().createQueryBuilder().where({
            platformId,
            status: InvitationStatus.ACCEPTED,
        }).andWhere('LOWER(user_invitation.email) = :email', { email: email.toLowerCase().trim() })
            .getMany()
        return invitations.length > 0
    },
    async getByEmailAndPlatformIdOrThrow({
        email,
        platformId,
        projectId,
    }: GetOneByPlatformIdAndEmailParams): Promise<UserInvitation | null> {
        return repo().findOneBy({
            email,
            platformId,
            projectId: isNil(projectId) ? IsNull() : projectId,
        })
    },
})


// app-sec (round 2): reverse-direction identity squatting. A directory-minted (LDAP) identity's
// membership on any given platform must come only from that platform's own directory sign-in
// (`ldapAuthnService.signIn`), which gates linking/adoption behind
// `assertIdentityIsNotPrivilegedElsewhere`. An invitation is a single admin's action on ONE
// platform and carries none of those checks — honoring it for an identity with no existing
// federated row on the invitation's own platform would let that platform's admin grant a user row
// (and, via `switchPlatform`, standing access) tied to a directory the platform never configured
// or vetted this identity against. Non-LDAP identities are unaffected.
async function isEligibleForInvitationProvisioning({ identity, platformId, log }: IsEligibleForInvitationProvisioningParams): Promise<boolean> {
    if (identity.provider !== UserIdentityProvider.LDAP) {
        return true
    }
    const existingUsers = await userService(log).getByIdentityId({ identityId: identity.id })
    const userOnPlatform = existingUsers.find((user) => user.platformId === platformId)
    if (isNil(userOnPlatform)) {
        return false
    }
    const federatedRow = await userFederatedIdentityService(log).findByUser({
        platformId,
        userId: userOnPlatform.id,
        provider: FederatedIdentityProvider.LDAP,
    })
    return !isNil(federatedRow)
}

async function generateInvitationLink(userInvitation: UserInvitation, expireyInSeconds: number): Promise<string> {
    const token = await jwtUtils.sign({
        payload: {
            id: userInvitation.id,
        },
        expiresInSeconds: expireyInSeconds,
        key: await jwtUtils.getJwtSecret(),
        audience: JwtAudience.USER_INVITATION,
    })

    return domainHelper.getPublicUrl({
        path: `invitation?token=${token}&email=${encodeURIComponent(userInvitation.email)}`,
    })
}
const enrichWithInvitationLink = async (userInvitation: UserInvitation, expireyInSeconds: number) => {
    const invitationLink = await generateInvitationLink(userInvitation, expireyInSeconds)
    return {
        ...userInvitation,
        link: invitationLink,
    }
}

const sendInvitationEmail = async ({ userInvitation, invitationLink, log }: SendInvitationEmailParams): Promise<void> => {
    const { error } = await tryCatch(async () => {
        const projectName = await resolveInvitationEntityName(userInvitation, log)
        await emailService(log).sendInvitation({
            email: userInvitation.email,
            platformId: userInvitation.platformId,
            projectName,
            invitationLink,
        })
    })
    if (error) {
        log.error({ error, email: userInvitation.email, platformId: userInvitation.platformId }, '[userInvitationsService#sendInvitationEmail] failed to send invitation email')
    }
}

const sendProjectMemberAddedEmail = async ({ invitation, log }: SendProjectMemberAddedEmailParams): Promise<void> => {
    const { error } = await tryCatch(async () => {
        assertNotNullOrUndefined(invitation.projectId, 'projectId')
        assertNotNullOrUndefined(invitation.projectRoleId, 'projectRoleId')
        const [projectName, projectRole] = await Promise.all([
            resolveInvitationEntityName(invitation, log),
            projectRoleRepo().findOneByOrFail({ id: invitation.projectRoleId }),
        ])
        await emailService(log).sendProjectMemberAdded({
            email: invitation.email,
            platformId: invitation.platformId,
            projectId: invitation.projectId,
            projectName,
            role: projectRole.name,
        })
    })
    if (error) {
        log.error({ error, email: invitation.email, platformId: invitation.platformId }, '[userInvitationsService#sendProjectMemberAddedEmail] failed to send project member added email')
    }
}

const resolveInvitationEntityName = async (userInvitation: UserInvitation, log: FastifyBaseLogger): Promise<string> => {
    if (userInvitation.type === InvitationType.PROJECT) {
        assertNotNullOrUndefined(userInvitation.projectId, 'projectId')
        const project = await projectService(log).getOneOrThrow(userInvitation.projectId)
        return project.displayName
    }
    const platform = await platformService(log).getOneOrThrow(userInvitation.platformId)
    return platform.name
}
type SendInvitationEmailParams = {
    userInvitation: UserInvitation
    invitationLink: string
    log: FastifyBaseLogger
}

type SendProjectMemberAddedEmailParams = {
    invitation: UserInvitation
    log: FastifyBaseLogger
}

type ListUserParams = {
    platformId: string
    type: InvitationType
    projectId: string | null
    status?: InvitationStatus
    limit: number
    cursor: string | null
}

type HasAnyAcceptedInvitationsParams = {
    email: string
    platformId: string
}
type ProvisionUserInvitationParams = {
    email: string
}

type IsEligibleForInvitationProvisioningParams = {
    identity: UserIdentity
    platformId: string
    log: FastifyBaseLogger
}

type PlatformAndIdParams = {
    id: string
    platformId: string
}
export type UserInvitationToken = {
    id: string
}

type AcceptParams = {
    invitationId: string
    platformId: string
}

type CreateParams = {
    email: string
    platformId: string
    platformRole: PlatformRole | null
    projectId: string | null
    status: InvitationStatus
    type: InvitationType
    projectRoleId: string | null
    invitationExpirySeconds: number
}



type GetOneByPlatformIdAndEmailParams = {
    email: string
    platformId: string
    projectId: string | null
}

import {
    apId,
    assertNotNullOrUndefined,
    Cursor,
    ErrorCode,
    isNil,
    PlatformId,
    PlatformRole,
    PlatformRoleManagedBy,
    ProjectId,
    ProjectType,
    QadamFlowError,
    SeekPage,
    spreadIfDefined,
    spreadIfNotUndefined,
    User,
    UserId,
    UserIdentity,
    UserStatus,
    UserWithBadges,
    UserWithMetaInformation,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { EntityManager, In, IsNull } from 'typeorm'
import { userFederatedIdentityService } from '../authentication/federated-identity/user-federated-identity-service'
import { userIdentityRepository, userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { platformService } from '../platform/platform.service'
import { projectService } from '../project/project-service'
import { UserEntity, UserSchema } from './user-entity'


export const userRepo = repoFactory(UserEntity)

export const userService = (log: FastifyBaseLogger) => ({
    async create(params: CreateParams): Promise<User> {
        const isActive = params.isActive ?? true
        const user: NewUser = {
            id: apId(),
            identityId: params.identityId,
            platformRole: params.platformRole,
            platformRoleManagedBy: PlatformRoleManagedBy.MANUAL,
            status: isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE,
            externalId: params.externalId,
            platformId: params.platformId,
        }
        return userRepo(params.entityManager).save(user)
    },
    async getOrCreateWithProject({ identity, platformId, entityManager }: GetOrCreateWithProjectParams): Promise<User> {
        const user = await this.getOneByIdentityAndPlatform({
            identityId: identity.id,
            platformId,
            entityManager,
        })
        if (isNil(user)) {
            const newUser = await this.create({
                identityId: identity.id,
                platformId,
                platformRole: PlatformRole.MEMBER,
                entityManager,
            })

            await projectService(log).create({
                displayName: identity.firstName + '\'s Project',
                ownerId: newUser.id,
                platformId,
                type: ProjectType.PERSONAL,
                entityManager,
            })
            return newUser
        }
        return user
    },
    async updateLastActiveDate({ id }: UpdateLastActiveDateParams): Promise<void> {
        await userRepo().update({ id }, { lastActiveDate: dayjs().toISOString() })
    },
    async update({ id, status, platformId, platformRole, externalId, source = 'ADMIN', platformRoleManualBaseline, entityManager }: UpdateParams): Promise<UserWithMetaInformation> {
        const user = await this.getOrThrow({ id })
        assertNotNullOrUndefined(user.platformId, 'platformId')

        if (user.platformId !== platformId) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'user',
                    entityId: id,
                },
            })
        }

        const platform = await platformService(log).getOneOrThrow(user.platformId)
        if (platform.ownerId === user.id && status === UserStatus.INACTIVE) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Admin cannot be deactivated',
                },
            })
        }

        await userRepo(entityManager).update({
            id,
            platformId,
        }, {
            ...spreadIfDefined('status', status),
            ...spreadIfDefined('platformRole', platformRole),
            ...spreadIfDefined('externalId', externalId),
            // An admin-path role write always resets provenance to MANUAL, so a later LDAP mapping
            // re-applying the *same* role it previously granted doesn't leave a stale LDAP marker
            // on what is now a manually-asserted role. The mapping's own write (`source: 'LDAP'`)
            // is the only path that sets LDAP instead.
            ...(platformRole !== undefined ? { platformRoleManagedBy: source === 'ADMIN' ? PlatformRoleManagedBy.MANUAL : PlatformRoleManagedBy.LDAP } : {}),
            // An admin's own role write is a fresh manual decision, so it forgets any raise
            // baseline a mapping recorded — the next mapping raise (if any) captures a new one from
            // here. The mapping's own path (`source: 'LDAP'`) passes `platformRoleManualBaseline`
            // explicitly (a role to set, or `null` once consumed by a revert) whenever it wants to
            // touch this column; every other write leaves it exactly as it was.
            ...(platformRole !== undefined && source === 'ADMIN' ? { platformRoleManualBaseline: null } : {}),
            ...spreadIfNotUndefined('platformRoleManualBaseline', source === 'LDAP' ? platformRoleManualBaseline : undefined),
        })

        // Any explicit *admin* status write — either direction — is a human decision that must
        // stick: it clears the directory's own "I deactivated this" marker, so reconcile can never
        // later reactivate a user an admin just acted on directly (app-sec: paths A and B).
        // Reconcile's own status writes (`source: 'LDAP'`) manage that marker themselves.
        if (status !== undefined && source === 'ADMIN') {
            await userFederatedIdentityService(log).clearDirectoryDisabledAtForUser({ userId: id, platformId, entityManager })
        }

        return this.getMetaInformation({ id })
    },
    async getUsersByIdentityId({ identityId }: GetUsersByIdentityIdParams): Promise<Pick<User, 'id' | 'platformId'>[]> {
        return userRepo().find({ where: { identityId } }).then((users) => users.map((user) => ({ id: user.id, platformId: user.platformId })))
    },
    // Batches reconcile's per-user status lookup (one linked-user set per platform) into a single
    // `IN (...)` query instead of N individual round trips. Scoped by `platformId` too, not only the
    // caller-supplied `ids`, for multi-tenant safety.
    async getStatusesByIds({ ids, platformId }: GetStatusesByIdsParams): Promise<Map<UserId, UserStatus>> {
        if (ids.length === 0) {
            return new Map()
        }
        const users = await userRepo().find({ where: { id: In(ids), platformId }, select: { id: true, status: true } })
        return new Map(users.map((user) => [user.id, user.status]))
    },
    // Atomic conditional transition — `UPDATE ... WHERE status = :expectedStatus` — used wherever a
    // caller must never overwrite a status a concurrent write already changed out from under it
    // (reconcile's deactivate/reactivate paths in particular, both of which race against an admin's
    // own status write on the same user). Returns whether the row actually matched and was updated;
    // `false` means the current status is no longer what the caller expected, and the caller must
    // treat that as "someone else already decided this", not merely "nothing to do".
    async transitionStatusIfCurrentlyEquals({ id, platformId, expectedStatus, newStatus, entityManager }: TransitionStatusIfCurrentlyEqualsParams): Promise<boolean> {
        const result = await userRepo(entityManager).update({ id, platformId, status: expectedStatus }, { status: newStatus })
        return (result.affected ?? 0) > 0
    },
    async list({ platformId, externalId, cursorRequest, limit }: ListParams): Promise<SeekPage<UserWithMetaInformation>> {
        const decodedCursor = paginationHelper.decodeCursor(cursorRequest)
        const paginator = buildPaginator({
            entity: UserEntity,
            query: {
                limit,
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const { data, cursor } = await paginator.paginate(userRepo().createQueryBuilder('user').where({
            platformId,
            ...spreadIfDefined('externalId', externalId),
        }))

        const usersWithMetaInformation = await Promise.all(data.map(this.getMetaInformation))
        return paginationHelper.createPage<UserWithMetaInformation>(usersWithMetaInformation, cursor)
    },
    async getByIdentityId({ identityId }: GetByIdentityId): Promise<UserSchema[]> {
        return userRepo().find({ where: { identityId } })
    },
    async getOneByIdentityAndPlatform({ identityId, platformId, entityManager }: GetOneByIdentityIdParams): Promise<User | null> {
        return userRepo(entityManager).findOneBy({ identityId, platformId: isNil(platformId) ? IsNull() : platformId })
    },
    async get({ id }: IdParams): Promise<User | null> {
        return userRepo().findOneBy({ id })
    },
    async getOrThrow({ id }: IdParams): Promise<User> {
        const user = await userRepo().findOneBy({ id })
        if (isNil(user)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'user', entityId: id },
            })
        }
        return user
    },
    async getOneOrFail({ id }: IdParams): Promise<User> {
        return userRepo().findOneOrFail({ where: { id } })
    },
    async getOneByIdAndPlatformIdOrThrow({ id, platformId }: GetOneByIdAndPlatformIdParams): Promise<UserWithBadges> {
        const user = await userRepo().findOne({ where: { id, platformId }, relations: { badges: true } })
        if (isNil(user)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'user', entityId: id },
            })
        }
        const meta = await this.getMetaInformation({ id })
        return {
            ...meta,
            badges: user.badges.map((badge) => ({
                name: badge.name,
                created: badge.created,
            })),
        }
    },
    async getOneByIdentityForOnboardingOrThrow({ identityId }: GetOneByIdentityForOnboardingParams): Promise<UserWithBadges> {
        // An ONBOARDING principal's id is the identity id, not a user id (see
        // getOnboardingResponse in authentication-utils.ts) — and onboarding is definitionally
        // pre-platform, so the row we want is the one this identity has with no platform yet.
        const user = await userRepo().findOne({ where: { identityId, platformId: IsNull() }, relations: { badges: true } })
        if (isNil(user)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'user', entityId: identityId },
            })
        }
        const meta = await this.getMetaInformation({ id: user.id })
        return {
            ...meta,
            badges: user.badges.map((badge) => ({
                name: badge.name,
                created: badge.created,
            })),
        }
    },
    async delete({ id, platformId }: DeleteParams): Promise<void> {
        await assertNotPlatformOwner({ id, platformId, log })
        await userRepo().delete({
            id,
            platformId,
        })
    },
    async removeFromPlatform({ id, platformId }: DeleteParams): Promise<void> {
        await assertNotPlatformOwner({ id, platformId, log })
        const user = await this.getOneOrFail({ id })
        await userRepo().update({
            id,
            platformId,
        }, {
            platformId: null,
        })
        await userIdentityRepository().update(user.identityId, {
            tokenVersion: nanoid(),
        })
        await userIdentityRepository().update({
            id: user.identityId,
            lastLoggedInPlatformId: platformId,
        }, {
            lastLoggedInPlatformId: null,
        })
    },

    async getByPlatformRole(id: PlatformId, role: PlatformRole): Promise<UserSchema[]> {
        return userRepo().find({ where: { platformId: id, platformRole: role }, relations: { identity: true } })
    },
    async listProjectUsers({ platformId, projectId }: ListUsersForProjectParams): Promise<UserWithMetaInformation[]> {
        const users = await getUsersForProject(platformId, projectId)
        const usersWithMetaInformation = await userRepo().find({ where: { platformId, id: In(users) }, relations: { identity: true } }).then((users) => users.map(this.getMetaInformation))
        return Promise.all(usersWithMetaInformation)
    },
    async getByPlatformAndExternalId({
        platformId,
        externalId,
    }: GetByPlatformAndExternalIdParams): Promise<User | null> {
        return userRepo().findOneBy({
            platformId,
            externalId,
        })
    },
    async getMetaInformation({ id }: IdParams): Promise<UserWithMetaInformation> {
        const user = await userRepo().findOneByOrFail({ id })
        const identity = await userIdentityService(log).getBasicInformation(user.identityId)
        return {
            id: user.id,
            email: identity.email,
            firstName: identity.firstName,
            lastName: identity.lastName,
            platformId: user.platformId,
            platformRole: user.platformRole,
            platformRoleManagedBy: user.platformRoleManagedBy,
            status: user.status,
            externalId: user.externalId,
            created: user.created,
            updated: user.updated,
            lastActiveDate: user.lastActiveDate,
            imageUrl: identity.imageUrl,
        }
    },

    async addOwnerToPlatform({
        id,
        platformId,
    }: UpdatePlatformIdParams): Promise<void> {
        await userRepo().update(id, {
            updated: dayjs().toISOString(),
            platformRole: PlatformRole.ADMIN,
            platformId,
        })
    },

    isUserPrivileged(user: User): boolean {
        return user.platformRole === PlatformRole.ADMIN || user.platformRole === PlatformRole.OPERATOR
    },
})


async function assertNotPlatformOwner({ id, platformId, log }: DeleteParams & { log: FastifyBaseLogger }): Promise<void> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    if (platform.ownerId === id) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: {
                message: 'Platform owner cannot be deleted',
            },
        })
    }
}

async function getUsersForProject(platformId: PlatformId, _projectId: string): Promise<UserId[]> {
    const platformAdmins = await userRepo().find({ where: { platformId, platformRole: PlatformRole.ADMIN } }).then((users) => users.map((user) => user.id))
    return platformAdmins
}

type UpdateLastActiveDateParams = {
    id: UserId
}

type GetOneByIdAndPlatformIdParams = {
    id: UserId
    platformId: PlatformId
}
type ListUsersForProjectParams = {
    projectId: ProjectId
    platformId: PlatformId
}

type DeleteParams = {
    id: UserId
    platformId: PlatformId
}


type ListParams = {
    platformId: PlatformId
    externalId?: string
    cursorRequest: Cursor
    limit?: number
}

type GetByIdentityId = {
    identityId: string
}


type GetOneByIdentityIdParams = {
    identityId: string
    platformId: PlatformId | null
    entityManager?: EntityManager
}

type GetOneByIdentityForOnboardingParams = {
    identityId: string
}

type UpdateParams = {
    id: UserId
    status?: UserStatus
    platformId: PlatformId
    platformRole?: PlatformRole
    externalId?: string
    // 'ADMIN' (the default) is every human-facing path — `POST /v1/users/:id`, invitation
    // provisioning. 'LDAP' is `ldapReconcileService`/`ldapGroupMappingService`'s own writes, which
    // manage `directoryDisabledAt`/`platformRoleManagedBy` themselves rather than having this
    // method reset them to the human-decision defaults.
    source?: 'ADMIN' | 'LDAP'
    // Only ever passed by `ldapGroupMappingService` (`source: 'LDAP'`): a `PlatformRole` to record
    // as the pre-raise MANUAL baseline (the mapping is raising a MANUAL role right now), or `null`
    // once a revert has consumed that baseline. Omitted (not merely `undefined` passed) by every
    // other caller, which leaves the column untouched — an admin write already clears it
    // unconditionally above, regardless of this param.
    platformRoleManualBaseline?: PlatformRole | null
    // `ldapReconcileService.deactivateUser` needs this write and its own `setDirectoryDisabledAt`
    // write to commit atomically — join the caller's own transaction rather than defaulting to the
    // pooled connection.
    entityManager?: EntityManager
}

type CreateParams = {
    identityId: string
    platformId: string | null
    externalId?: string
    platformRole: PlatformRole
    isActive?: boolean
    entityManager?: EntityManager
}
type GetUsersByIdentityIdParams = {
    identityId: string
}
type GetStatusesByIdsParams = {
    ids: UserId[]
    platformId: PlatformId
}

type TransitionStatusIfCurrentlyEqualsParams = {
    id: UserId
    platformId: PlatformId
    expectedStatus: UserStatus
    newStatus: UserStatus
    entityManager?: EntityManager
}

type NewUser = Omit<User, 'created' | 'updated'>

type GetByPlatformAndExternalIdParams = {
    platformId: string
    externalId: string
}

type IdParams = {
    id: UserId
}

type UpdatePlatformIdParams = {
    id: UserId
    platformId: string
}

type GetOrCreateWithProjectParams = {
    identity: UserIdentity
    platformId: string
    entityManager?: EntityManager
}

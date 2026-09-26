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
    async update({ id, status, platformId, platformRole, externalId, source = 'ADMIN' }: UpdateParams): Promise<UserWithMetaInformation> {
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

        // Cleared *both before and after* the status write, not just before: reconcile's own
        // reactivation (`clearDirectoryDisabledAtIfSet`) is a conditional, atomic "clear only if
        // still set", but reconcile's *deactivation* path (`deactivateUser`) independently *sets*
        // the marker whenever it decides — in its own, concurrently-running tick — that this same
        // user is gone or disabled in the directory. That set can land in the window between this
        // clear and this write's own `status` write below: this write then completes the admin's
        // decision (e.g. re-activating a user, or deactivating one for a reason that has nothing to
        // do with the directory), but leaves reconcile's freshly-set marker in place, stale — and a
        // *later* directory re-enable would then reactivate this user on the strength of a marker
        // the admin never intended to exist, undoing a decision `source: 'ADMIN'` is supposed to own
        // outright. A single clear-before closes the narrower race this comment used to describe (a
        // concurrent reconcile *reactivation* seeing the marker still set and this write's `status`
        // already flipped), but not this one, since nothing before the status write can observe or
        // prevent reconcile *setting* the marker fresh in that same window. Clearing again after the
        // status write closes it: whatever value the marker holds by the time this write's own
        // status change has committed, the second clear removes it, so an ADMIN write's completed
        // decision is never left paired with a directory-owned marker it didn't set. Reconcile's own
        // status writes (`source: 'LDAP'`) manage the marker themselves and never trigger either
        // clear; only `source: 'ADMIN'` (the admin controller's own default) does, and only when
        // `status` is actually part of this update.
        if (status !== undefined && source === 'ADMIN') {
            await userFederatedIdentityService(log).clearDirectoryDisabledAtForUser({ userId: id, platformId })
        }

        await userRepo().update({
            id,
            platformId,
        }, {
            ...spreadIfDefined('status', status),
            ...spreadIfDefined('platformRole', platformRole),
            ...spreadIfDefined('externalId', externalId),
            // An admin-path role write always resets provenance to MANUAL, so a later LDAP mapping
            // re-applying the *same* role it previously granted doesn't leave a stale LDAP marker
            // on what is now a manually-asserted role. `source: 'LDAP'` exists on this method only
            // so a test can seed that prior state directly without going through the real LDAP flow
            // (see `ldap-reconcile.test.ts`) — the actual LDAP-driven write path
            // (`ldapGroupMappingService.applyPlatformRoleGrant`) never calls this method at all; it
            // uses `transitionPlatformRoleIfCurrentlyEquals` instead, specifically so it can
            // condition its own write on the exact row state it read (see that method's comment).
            ...(platformRole !== undefined ? { platformRoleManagedBy: source === 'ADMIN' ? PlatformRoleManagedBy.MANUAL : PlatformRoleManagedBy.LDAP } : {}),
            // An admin's own role write is a fresh manual decision, so it forgets any raise
            // baseline a mapping recorded — the next mapping raise (if any) captures a fresh one
            // through `transitionPlatformRoleIfCurrentlyEquals`'s own read, not a value left over
            // here from before.
            ...(platformRole !== undefined && source === 'ADMIN' ? { platformRoleManualBaseline: null } : {}),
        })

        // See the comment above the first clear: this second clear is what actually closes the
        // race, since only *after* the status write has committed can we be sure no later marker
        // set by a concurrently-running reconcile tick is still an accurate reflection of anything
        // this admin write did.
        if (status !== undefined && source === 'ADMIN') {
            await userFederatedIdentityService(log).clearDirectoryDisabledAtForUser({ userId: id, platformId })
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
    // The same atomic-conditional-write pattern as `transitionStatusIfCurrentlyEquals`, for
    // `platformRole`/`platformRoleManagedBy`/`platformRoleManualBaseline` together — used by
    // `ldapGroupMappingService.applyPlatformRoleGrant`, which reads a user's current role/provenance
    // (`getOrThrow`), decides what to write, and would otherwise write it back unconditionally: an
    // admin write landing in that gap (e.g. demoting the same user) would get silently overwritten
    // by the mapping's now-stale decision. Conditioning the write on the exact
    // (`platformRole`, `platformRoleManagedBy`) pair the caller read makes the whole read-decide-
    // write sequence equivalent to a single atomic compare-and-swap; `false` means someone else
    // already changed the row since the read, and the caller must treat that as "someone else
    // already decided this", the same as every other conditional transition in this codebase.
    async transitionPlatformRoleIfCurrentlyEquals({ id, platformId, expectedPlatformRole, expectedPlatformRoleManagedBy, newPlatformRole, newPlatformRoleManagedBy, newPlatformRoleManualBaseline, entityManager }: TransitionPlatformRoleIfCurrentlyEqualsParams): Promise<boolean> {
        const result = await userRepo(entityManager).update(
            { id, platformId, platformRole: expectedPlatformRole, platformRoleManagedBy: expectedPlatformRoleManagedBy },
            { platformRole: newPlatformRole, platformRoleManagedBy: newPlatformRoleManagedBy, platformRoleManualBaseline: newPlatformRoleManualBaseline },
        )
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
    // provisioning. 'LDAP' exists only so a test can seed a pre-existing LDAP-managed role/status
    // directly, without going through the real LDAP flow (see `ldap-reconcile.test.ts`) — no
    // production caller passes it: `ldapGroupMappingService`'s own platform-role write uses
    // `transitionPlatformRoleIfCurrentlyEquals`, and `ldapReconcileService`'s own status writes use
    // `transitionStatusIfCurrentlyEquals`/`setDirectoryDisabledAt` directly, neither of which goes
    // through this method at all.
    source?: 'ADMIN' | 'LDAP'
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

type TransitionPlatformRoleIfCurrentlyEqualsParams = {
    id: UserId
    platformId: PlatformId
    expectedPlatformRole: PlatformRole
    expectedPlatformRoleManagedBy: PlatformRoleManagedBy
    newPlatformRole: PlatformRole
    newPlatformRoleManagedBy: PlatformRoleManagedBy
    newPlatformRoleManualBaseline: PlatformRole | null
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

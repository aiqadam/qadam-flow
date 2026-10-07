import {
    DefaultProjectRole,
    ErrorCode,
    InvitationStatus,
    isNil,
    PlatformRole,
    Project,
    ProjectMember,
    ProjectMemberCandidate,
    ProjectMemberManagedBy,
    ProjectMemberWithUser,
    ProjectRole,
    ProjectType,
    QadamFlowError,
    RoleType,
    UserStatus,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { UserEntity } from '../../user/user-entity'
import { UserInvitationEntity } from '../../user-invitations/user-invitation.entity'
import { ProjectMemberEntity } from '../project-member.entity'
import { ProjectRoleEntity } from '../project-role.entity'
import { projectService, throwNoProjectAccess } from '../project-service'

const repo = repoFactory(ProjectMemberEntity)
const projectRoleRepo = repoFactory(ProjectRoleEntity)
const userRepo = repoFactory(UserEntity)

// The picker loads candidates in one call (no pagination), so bound the response rather than let a
// large platform directory produce an unbounded result set.
const MAX_CANDIDATE_RESULTS = 1000

// The search term reaches a leading-wildcard `LIKE` scan; bound its length so a caller cannot drive
// an arbitrarily expensive scan with one request.
const MAX_SEARCH_LENGTH = 200

const memberWithUserSelect = [
    'pm.id AS id',
    'pm."userId" AS "userId"',
    'pm."projectId" AS "projectId"',
    'pm."managedBy" AS "managedBy"',
    'ui.email AS email',
    'ui."firstName" AS "firstName"',
    'ui."lastName" AS "lastName"',
    'pr.name AS "projectRole"',
]

export const projectMemberService = (log: FastifyBaseLogger) => ({
    async list({ projectId }: ListParams): Promise<ProjectMemberWithUser[]> {
        return repo().createQueryBuilder('pm')
            // A `project_member` row outlives offboarding (`removeFromPlatform` only nulls
            // `user.platformId`) and deactivation (which only flips `user.status`); neither user can
            // reach the project, so hide them — the same rows the last-admin guard refuses to count.
            .innerJoin('user', 'usr', 'usr.id = pm."userId" AND usr."platformId" = pm."platformId"')
            .innerJoin('user_identity', 'ui', 'ui.id = usr."identityId"')
            .innerJoin('project_role', 'pr', 'pr.id = pm."projectRoleId"')
            .where('pm."projectId" = :projectId', { projectId })
            .andWhere('usr.status = :activeStatus', { activeStatus: UserStatus.ACTIVE })
            .select(memberWithUserSelect)
            .getRawMany<ProjectMemberWithUser>()
    },

    // Deliberately NOT the platform user list (`GET /v1/users` is platformAdminOnly): a project
    // ADMIN may be a plain platform MEMBER. Excludes users already in the project, users with a
    // PENDING invitation for it, platform ADMIN/OPERATOR (they have platform-level access already),
    // and non-ACTIVE users.
    async listCandidates({ platformId, projectId, search }: ListCandidatesParams): Promise<ProjectMemberCandidate[]> {
        // The picker lives in a TEAM project's members tab. Refuse PERSONAL projects explicitly:
        // their owner resolves to the permission `bypass`, so without this a plain platform MEMBER
        // could pass their own personal project id and read the whole platform user directory —
        // exactly what `GET /v1/users` (platformAdminOnly) withholds.
        const project = await projectService(log).getOneOrThrow(projectId)
        if (project.type !== ProjectType.TEAM) {
            throwNoProjectAccess()
        }
        const query = userRepo().createQueryBuilder('usr')
            .innerJoin('user_identity', 'ui', 'ui.id = usr."identityId"')
            .leftJoin('project_member', 'pm', 'pm."userId" = usr.id AND pm."projectId" = :projectId')
            .leftJoin('user_invitation', 'inv', 'LOWER(inv.email) = LOWER(ui.email) AND inv."projectId" = :projectId AND inv.status = :pendingStatus')
            .where('usr."platformId" = :platformId', { platformId })
            .andWhere('usr.status = :activeStatus', { activeStatus: UserStatus.ACTIVE })
            .andWhere('usr."platformRole" NOT IN (:...privilegedRoles)', {
                privilegedRoles: [PlatformRole.ADMIN, PlatformRole.OPERATOR],
            })
            .andWhere('pm.id IS NULL')
            .andWhere('inv.id IS NULL')
            .setParameters({ projectId, pendingStatus: InvitationStatus.PENDING })
        // The picker searches as the user types, so the result cap only bites an empty search on a
        // platform with more than `MAX_CANDIDATE_RESULTS` users.
        const searchTerm = search?.trim().slice(0, MAX_SEARCH_LENGTH)
        if (!isNil(searchTerm) && searchTerm.length > 0) {
            query.andWhere(
                '(LOWER(ui.email) LIKE :search OR LOWER(ui."firstName") LIKE :search OR LOWER(ui."lastName") LIKE :search)',
                { search: `%${searchTerm.toLowerCase()}%` },
            )
        }
        return query
            .select([
                'usr.id AS "userId"',
                'ui.email AS email',
                'ui."firstName" AS "firstName"',
                'ui."lastName" AS "lastName"',
            ])
            .orderBy('ui.email', 'ASC')
            .limit(MAX_CANDIDATE_RESULTS)
            .getRawMany<ProjectMemberCandidate>()
    },

    async update({ projectId, memberId, actorUserId, projectRole }: UpdateParams): Promise<ProjectMemberWithUser> {
        return repo().manager.transaction(async (entityManager) => {
            const { member, project, members } = await lockAndLoadMember({ entityManager, projectId, memberId, actorUserId, log })
            const role = await getDefaultProjectRole({ entityManager, platformId: project.platformId, name: projectRole })
            if (role.name !== DefaultProjectRole.ADMIN) {
                await assertNotLastAdmin({ entityManager, member, members, platformId: project.platformId })
            }
            if (role.id !== member.projectRoleId) {
                await entityManager.update(ProjectMemberEntity, { id: member.id, projectId }, { projectRoleId: role.id })
            }
            return getMemberWithUserOrThrow({ entityManager, projectId, memberId })
        })
    },

    // Returns the removed user's id so the caller can evict their sockets — a side effect that must
    // happen only after this transaction commits.
    async remove({ projectId, memberId, actorUserId }: RemoveParams): Promise<string> {
        return repo().manager.transaction(async (entityManager) => {
            const { member, project, members } = await lockAndLoadMember({ entityManager, projectId, memberId, actorUserId, log })
            const memberWithUser = await getMemberWithUserOrThrow({ entityManager, projectId, memberId })
            await assertNotLastAdmin({ entityManager, member, members, platformId: project.platformId })
            await entityManager.delete(ProjectMemberEntity, { id: member.id, projectId })
            // A pending invitation for the same email would re-add the user on acceptance, silently
            // undoing the removal — revoke it in the same transaction.
            await entityManager.createQueryBuilder()
                .delete()
                .from(UserInvitationEntity)
                .where('"projectId" = :projectId AND status = :status AND LOWER(email) = :email', {
                    projectId,
                    status: InvitationStatus.PENDING,
                    email: memberWithUser.email.toLowerCase().trim(),
                })
                .execute()
            return member.userId
        })
    },

    // Uses the same shared resolver as `authorize.ts:assertAccessToProject` and the websocket
    // join, so the role reported here matches what the server would actually enforce on a
    // mutation — a stale answer here would recreate the exact UX gap this endpoint exists to close.
    async getMyRole({ projectId, userId }: GetMyRoleParams): Promise<{ role: DefaultProjectRole }> {
        const access = await projectService(log).resolveUserProjectAccessOrThrow({ userId, projectId })
        // A `bypass` is the privileged-user / PERSONAL-owner case; both act as project ADMIN.
        if (access.kind === 'bypass') {
            return { role: DefaultProjectRole.ADMIN }
        }
        if (!isDefaultProjectRole(access.role.name)) {
            // `securityAccess.project` already asserted the caller has access to this project, so
            // reaching here means the membership row names a non-default role (which CE never
            // creates) — not a normal 403.
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'Unable to resolve a default project role for this member.',
                },
            })
        }
        return { role: access.role.name }
    },
})

// Locks every membership row of the project so two concurrent demote/remove calls cannot both see
// "more than one admin" and leave the project with none. Loads the target and applies the
// immutability guards (LDAP-managed, owner, self) in one place shared by update and remove.
async function lockAndLoadMember({ entityManager, projectId, memberId, actorUserId, log }: LockAndLoadMemberParams): Promise<LockedMember> {
    const members = await entityManager.createQueryBuilder(ProjectMemberEntity, 'pm')
        .setLock('pessimistic_write')
        .where('pm."projectId" = :projectId', { projectId })
        .getMany()
    const member = members.find((candidate) => candidate.id === memberId)
    if (isNil(member)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: memberId, entityType: 'ProjectMember' },
        })
    }
    const project = await projectService(log).getOneOrThrow(projectId)
    assertMemberIsMutable({ member, project, actorUserId })
    return { member, project, members }
}

function assertMemberIsMutable({ member, project, actorUserId }: AssertMemberIsMutableParams): void {
    // Only `ldapGroupMappingService` may write an LDAP-managed row (see `.agents/features/projects.md`).
    // A manual edit here would be reverted — or worse, duplicated — by the next directory reconcile.
    if (member.managedBy === ProjectMemberManagedBy.LDAP) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'This membership is managed by the directory and cannot be changed here.' },
        })
    }
    // The owner keeps access through `project.ownerId` even without the row, so removing it would
    // leave a "removed" member who still has access.
    if (member.userId === project.ownerId) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'The project owner cannot be removed or have their role changed.' },
        })
    }
    if (member.userId === actorUserId) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'You cannot change or remove your own membership.' },
        })
    }
}

async function assertNotLastAdmin({ entityManager, member, members, platformId }: AssertNotLastAdminParams): Promise<void> {
    const adminRole = await getDefaultProjectRole({ entityManager, platformId, name: DefaultProjectRole.ADMIN })
    if (member.projectRoleId !== adminRole.id) {
        return
    }
    // `project_member` rows outlive offboarding (`userService.removeFromPlatform` only nulls
    // `user.platformId`) and deactivation (which only flips `user.status`), and neither can
    // administer the project — `resolveUserProjectAccessOrThrow` denies an INACTIVE user and a
    // detached one. So an orphaned or deactivated admin row must not be mistaken for a working one:
    // count only ACTIVE admins still attached to this platform, and require that at least one
    // *other* one remains.
    const adminUserIds = members
        .filter((candidate) => candidate.projectRoleId === adminRole.id)
        .map((candidate) => candidate.userId)
    const attachedAdmins = await userRepo(entityManager).find({
        where: { id: In(adminUserIds), platformId, status: UserStatus.ACTIVE },
    })
    const remainingActiveAdmins = attachedAdmins.filter((user) => user.id !== member.userId).length
    if (remainingActiveAdmins < 1) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'The last admin of the project cannot be removed or demoted.' },
        })
    }
}

async function getDefaultProjectRole({ entityManager, platformId, name }: GetDefaultProjectRoleParams): Promise<ProjectRole> {
    return projectRoleRepo(entityManager).findOneByOrFail({
        platformId,
        name,
        type: RoleType.DEFAULT,
    })
}

async function getMemberWithUserOrThrow({ entityManager, projectId, memberId }: GetMemberWithUserParams): Promise<ProjectMemberWithUser> {
    const member = await entityManager.createQueryBuilder(ProjectMemberEntity, 'pm')
        .innerJoin('user', 'usr', 'usr.id = pm."userId"')
        .innerJoin('user_identity', 'ui', 'ui.id = usr."identityId"')
        .innerJoin('project_role', 'pr', 'pr.id = pm."projectRoleId"')
        .where('pm.id = :memberId AND pm."projectId" = :projectId', { memberId, projectId })
        .select(memberWithUserSelect)
        .getRawOne<ProjectMemberWithUser>()
    if (isNil(member)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: memberId, entityType: 'ProjectMember' },
        })
    }
    return member
}

function isDefaultProjectRole(name: string): name is DefaultProjectRole {
    const roles: string[] = Object.values(DefaultProjectRole)
    return roles.includes(name)
}

type ListParams = {
    projectId: string
}

type ListCandidatesParams = {
    platformId: string
    projectId: string
    search?: string
}

type UpdateParams = {
    projectId: string
    memberId: string
    actorUserId: string
    projectRole: DefaultProjectRole
}

type RemoveParams = {
    projectId: string
    memberId: string
    actorUserId: string
}

type GetMyRoleParams = {
    projectId: string
    userId: string
}

type LockAndLoadMemberParams = {
    entityManager: EntityManager
    projectId: string
    memberId: string
    actorUserId: string
    log: FastifyBaseLogger
}

type LockedMember = {
    member: ProjectMember
    project: Project
    members: ProjectMember[]
}

type AssertMemberIsMutableParams = {
    member: ProjectMember
    project: Project
    actorUserId: string
}

type AssertNotLastAdminParams = {
    entityManager: EntityManager
    member: ProjectMember
    members: ProjectMember[]
    platformId: string
}

type GetDefaultProjectRoleParams = {
    entityManager: EntityManager
    platformId: string
    name: DefaultProjectRole
}

type GetMemberWithUserParams = {
    entityManager: EntityManager
    projectId: string
    memberId: string
}

import { apId, isNil, LdapConfig, PlatformId, PlatformRole, PlatformRoleManagedBy, ProjectMemberManagedBy, ProjectType, UserId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { platformService } from '../../platform/platform.service'
import { ProjectMemberEntity } from '../../project/project-member.entity'
import { projectService } from '../../project/project-service'
import { userService } from '../../user/user-service'
import { ldapGroupMappingUtils } from './ldap-group-mapping'

const projectMemberRepo = repoFactory(ProjectMemberEntity)

export const ldapGroupMappingService = (log: FastifyBaseLogger) => ({
    // Applied at every successful sign-in and by reconcile — the caller only ever has to pass the
    // group DNs it already resolved (`memberOf`, plus a nested-group search when configured); every
    // DB write this makes is idempotent, so applying the same grants twice is a no-op past the
    // first call.
    async applyMapping({ platformId, userId, config, memberGroupDns }: ApplyMappingParams): Promise<void> {
        const { platformRole, projectRoles } = ldapGroupMappingUtils.resolveGrants({
            groupMappings: config.groupMappings,
            memberGroupDns,
        })
        await applyPlatformRoleGrant({ platformId, userId, platformRole, log })
        await applyProjectGrants({ platformId, userId, projectRoles, log })
    },
})

// Never touches the platform owner. Two directions, both gated on provenance — a directory-granted
// ADMIN must be revocable, and a manually-set role must never be demoted by a mapping:
// - A resolved role (some group matched with a `platformRole` set) always applies, and always
//   marks the role LDAP-managed, when the role is *already* LDAP-managed — an explicit group grant
//   is a real, current directory decision, and always wins over whatever the *previous* mapping
//   decided, in either direction. Against a MANUAL role, though, a mapping may only ever *raise*
//   it (e.g. a manually-set MEMBER promoted to ADMIN by a matching group) — never lower or hold it
//   at or below its current rank. Raising a MANUAL role is itself what flips its provenance to
//   LDAP going forward; a mapped MEMBER/OPERATOR must never overwrite an admin's own ADMIN
//   promotion. Raising a MANUAL role also records it as `platformRoleManualBaseline` — the exact
//   role an admin left this user at — so a later revert can restore that instead of falling all
//   the way back to MEMBER: "manual roles are never demoted" applies to a mapping-raised role too,
//   once the raise that granted it is later revoked by the same mapping.
// - No resolved role (no matching group grants one) only *reverts* the role, and only when the
//   role is currently LDAP-managed — a manually-set role (`platformRoleManagedBy: 'MANUAL'`) is
//   never touched by the absence of a mapping match. The revert target is the recorded
//   `platformRoleManualBaseline` when one is set (the admin's own role before this mapping ever
//   raised it), or MEMBER when there is none (e.g. the row was created straight into an LDAP grant
//   with no prior manual role to remember). Restoring a recorded baseline is restoring a human
//   decision, so provenance goes back to `MANUAL` too — leaving it `LDAP` would mean the *very
//   next* mapping pass treats this already-restored MANUAL role as still LDAP-managed and eligible
//   to raise again unconditionally, silently discarding the fact that the mapping's own grant was
//   just revoked; the baseline would also never be recorded again on a later raise (the raise
//   branch above only records one when raising *from* MANUAL), so a second raise-then-revert cycle
//   would fall all the way to MEMBER instead of back to the admin's real role, the one-baseline-
//   thick tracking silently correct on the first cycle and wrong on every one after. Falling back
//   to MEMBER (no baseline recorded) keeps today's LDAP-managed provenance, since there is no human
//   decision being restored. The baseline is cleared in the same write either way, since a revert
//   fully consumes it — a subsequent raise records a fresh one from whatever the role is at that
//   point.
//
// The read (`getOrThrow`) and the write below are not one atomic operation — an admin could change
// this same user's role in the gap between them. `transitionPlatformRoleIfCurrentlyEquals` closes
// that: the write only takes effect if the row still matches the exact `(platformRole,
// platformRoleManagedBy)` pair just read, otherwise it is a no-op and this mapping pass's decision
// is silently superseded by whatever the concurrent write left behind, the same as every other
// conditional write in this codebase.
async function applyPlatformRoleGrant({ platformId, userId, platformRole, log }: ApplyPlatformRoleGrantParams): Promise<void> {
    const [platform, user] = await Promise.all([
        platformService(log).getOneOrThrow(platformId),
        userService(log).getOrThrow({ id: userId }),
    ])
    if (user.id === platform.ownerId) {
        return
    }
    const isManuallyManaged = user.platformRoleManagedBy === PlatformRoleManagedBy.MANUAL

    if (!isNil(platformRole)) {
        if (isManuallyManaged && ldapGroupMappingUtils.platformRoleRank(platformRole) <= ldapGroupMappingUtils.platformRoleRank(user.platformRole)) {
            return
        }
        if (user.platformRole === platformRole && user.platformRoleManagedBy === PlatformRoleManagedBy.LDAP) {
            return
        }
        const isRaisingFromManual = isManuallyManaged
        await userService(log).transitionPlatformRoleIfCurrentlyEquals({
            id: userId,
            platformId,
            expectedPlatformRole: user.platformRole,
            expectedPlatformRoleManagedBy: user.platformRoleManagedBy,
            newPlatformRole: platformRole,
            newPlatformRoleManagedBy: PlatformRoleManagedBy.LDAP,
            newPlatformRoleManualBaseline: isRaisingFromManual ? user.platformRole : (user.platformRoleManualBaseline ?? null),
        })
        return
    }

    if (isManuallyManaged) {
        return
    }
    const revertingToBaseline = !isNil(user.platformRoleManualBaseline)
    const revertRole = user.platformRoleManualBaseline ?? PlatformRole.MEMBER
    if (user.platformRole !== revertRole || revertingToBaseline) {
        await userService(log).transitionPlatformRoleIfCurrentlyEquals({
            id: userId,
            platformId,
            expectedPlatformRole: user.platformRole,
            expectedPlatformRoleManagedBy: user.platformRoleManagedBy,
            newPlatformRole: revertRole,
            newPlatformRoleManagedBy: revertingToBaseline ? PlatformRoleManagedBy.MANUAL : PlatformRoleManagedBy.LDAP,
            newPlatformRoleManualBaseline: null,
        })
    }
}

// Only ever creates, updates or removes a `project_member` row this mapping itself marked
// `LDAP`-managed. A manually-added membership is never touched, even when it also matches a group
// mapping — the design's "a manual membership that also matches a mapping stays manual".
async function applyProjectGrants({ platformId, userId, projectRoles, log }: ApplyProjectGrantsParams): Promise<void> {
    const existingManagedRows = await projectMemberRepo().find({
        where: { userId, platformId, managedBy: ProjectMemberManagedBy.LDAP },
    })
    const existingManagedByProjectId = new Map(existingManagedRows.map((row) => [row.projectId, row]))

    for (const [projectId, role] of projectRoles) {
        const belongsToPlatform = await projectBelongsToPlatformAsTeam({ projectId, platformId, log })
        if (!belongsToPlatform) {
            // Defense in depth: the mapping was validated against this platform's own TEAM
            // projects at save time, but the project may have been deleted, moved, or changed
            // type since — never trust the stored projectId again without re-checking it here too.
            log.warn({ platformId, projectId }, '[ldapGroupMappingService] Skipping a group-mapping project grant for a project that is no longer a TEAM project on this platform')
            continue
        }
        const projectRoleId = await projectService(log).getOrCreateDefaultProjectRoleId({ platformId, role })
        const existingRow = existingManagedByProjectId.get(projectId)
        const existingAnyRow = isNil(existingRow) ? await projectMemberRepo().findOneBy({ userId, projectId }) : existingRow
        if (!isNil(existingAnyRow) && existingAnyRow.managedBy !== ProjectMemberManagedBy.LDAP) {
            continue
        }
        await upsertLdapManagedMembership({ id: existingAnyRow?.id ?? apId(), userId, projectId, projectRoleId, platformId })
        existingManagedByProjectId.delete(projectId)
    }

    const projectIdsToRemove = [...existingManagedByProjectId.keys()]
    if (projectIdsToRemove.length > 0) {
        await projectMemberRepo().delete({ userId, platformId, projectId: In(projectIdsToRemove), managedBy: ProjectMemberManagedBy.LDAP })
    }
}

// A plain `.upsert()` (`INSERT ... ON CONFLICT (userId, projectId) DO UPDATE SET ...`) updates
// unconditionally on conflict — a race between this function's own pre-check above and this
// insert (e.g. a concurrent invitation-acceptance creating a MANUAL row for the same user+project)
// could otherwise flip a freshly-created MANUAL row to LDAP. The `WHERE` clause on the conflict
// target makes the update itself conditional: a MANUAL row already there is left exactly as
// written, and the `DO UPDATE` becomes a no-op for it, closing the window atomically rather than
// only in the common (no-race) case the pre-check above already handles.
async function upsertLdapManagedMembership({ id, userId, projectId, projectRoleId, platformId }: UpsertLdapManagedMembershipParams): Promise<void> {
    const now = new Date().toISOString()
    await projectMemberRepo()
        .createQueryBuilder()
        .insert()
        .into(ProjectMemberEntity)
        .values({
            id,
            userId,
            projectId,
            projectRoleId,
            platformId,
            managedBy: ProjectMemberManagedBy.LDAP,
            created: now,
            updated: now,
        })
        .onConflict('("userId", "projectId") DO UPDATE SET "projectRoleId" = EXCLUDED."projectRoleId", "managedBy" = EXCLUDED."managedBy", "updated" = EXCLUDED."updated" WHERE "project_member"."managedBy" = \'LDAP\'')
        .execute()
}

async function projectBelongsToPlatformAsTeam({ projectId, platformId, log }: ProjectBelongsToPlatformParams): Promise<boolean> {
    const project = await projectService(log).getOne(projectId)
    return !isNil(project) && project.platformId === platformId && project.type === ProjectType.TEAM
}

type ApplyMappingParams = {
    platformId: PlatformId
    userId: UserId
    config: LdapConfig
    memberGroupDns: string[]
}

type ApplyPlatformRoleGrantParams = {
    platformId: PlatformId
    userId: UserId
    platformRole: ReturnType<typeof ldapGroupMappingUtils.resolveGrants>['platformRole']
    log: FastifyBaseLogger
}

type ApplyProjectGrantsParams = {
    platformId: PlatformId
    userId: UserId
    projectRoles: ReturnType<typeof ldapGroupMappingUtils.resolveGrants>['projectRoles']
    log: FastifyBaseLogger
}

type UpsertLdapManagedMembershipParams = {
    id: string
    userId: UserId
    projectId: string
    projectRoleId: string
    platformId: PlatformId
}

type ProjectBelongsToPlatformParams = {
    projectId: string
    platformId: PlatformId
    log: FastifyBaseLogger
}

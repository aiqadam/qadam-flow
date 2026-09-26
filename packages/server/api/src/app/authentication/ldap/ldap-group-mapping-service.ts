import { apId, isNil, LdapConfig, PlatformId, ProjectMemberManagedBy, UserId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In } from 'typeorm'
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
    async applyMapping({ platformId, userId, config, memberGroupDns, entityManager }: ApplyMappingParams): Promise<void> {
        const { platformRole, projectRoles } = ldapGroupMappingUtils.resolveGrants({
            groupMappings: config.groupMappings,
            memberGroupDns,
        })
        await applyPlatformRoleGrant({ platformId, userId, platformRole, log, entityManager })
        await applyProjectGrants({ platformId, userId, projectRoles, log, entityManager })
    },
})

// Never touches the platform owner — the owner's role is not something a directory should ever be
// able to move, the same break-glass `ldapAuthnService` already gives the owner against linking.
// A mapping with no matching group at all resolves `platformRole: null`, which must leave the
// user's current role untouched rather than reset it to anything.
async function applyPlatformRoleGrant({ platformId, userId, platformRole, log }: ApplyPlatformRoleGrantParams): Promise<void> {
    if (isNil(platformRole)) {
        return
    }
    const [platform, user] = await Promise.all([
        platformService(log).getOneOrThrow(platformId),
        userService(log).getOrThrow({ id: userId }),
    ])
    if (user.id === platform.ownerId || user.platformRole === platformRole) {
        return
    }
    await userService(log).update({ id: userId, platformId, platformRole })
}

// Only ever creates, updates or removes a `project_member` row this mapping itself marked
// `LDAP`-managed. A manually-added membership is never touched, even when it also matches a group
// mapping — the design's "a manual membership that also matches a mapping stays manual".
async function applyProjectGrants({ platformId, userId, projectRoles, log, entityManager }: ApplyProjectGrantsParams): Promise<void> {
    const existingManagedRows = await projectMemberRepo(entityManager).find({
        where: { userId, platformId, managedBy: ProjectMemberManagedBy.LDAP },
    })
    const existingManagedByProjectId = new Map(existingManagedRows.map((row) => [row.projectId, row]))

    for (const [projectId, role] of projectRoles) {
        const belongsToPlatform = await projectBelongsToPlatform({ projectId, platformId, log })
        if (!belongsToPlatform) {
            // Defense in depth: the mapping was validated against this platform's own projects at
            // save time, but the project may have been deleted, or moved, since — never trust the
            // stored projectId again without re-checking it at apply time too.
            log.warn({ platformId, projectId }, '[ldapGroupMappingService] Skipping a group-mapping project grant for a project that no longer belongs to this platform')
            continue
        }
        const projectRoleId = await projectService(log).getOrCreateDefaultProjectRoleId({ platformId, role, entityManager })
        const existingRow = existingManagedByProjectId.get(projectId)
        const existingAnyRow = isNil(existingRow) ? await projectMemberRepo(entityManager).findOneBy({ userId, projectId }) : existingRow
        if (!isNil(existingAnyRow) && existingAnyRow.managedBy !== ProjectMemberManagedBy.LDAP) {
            continue
        }
        await projectMemberRepo(entityManager).upsert({
            id: existingAnyRow?.id ?? apId(),
            userId,
            projectId,
            projectRoleId,
            platformId,
            managedBy: ProjectMemberManagedBy.LDAP,
        }, ['userId', 'projectId'])
        existingManagedByProjectId.delete(projectId)
    }

    const projectIdsToRemove = [...existingManagedByProjectId.keys()]
    if (projectIdsToRemove.length > 0) {
        await projectMemberRepo(entityManager).delete({ userId, platformId, projectId: In(projectIdsToRemove), managedBy: ProjectMemberManagedBy.LDAP })
    }
}

async function projectBelongsToPlatform({ projectId, platformId, log }: ProjectBelongsToPlatformParams): Promise<boolean> {
    const project = await projectService(log).getOne(projectId)
    return !isNil(project) && project.platformId === platformId
}

type ApplyMappingParams = {
    platformId: PlatformId
    userId: UserId
    config: LdapConfig
    memberGroupDns: string[]
    entityManager?: EntityManager
}

type ApplyPlatformRoleGrantParams = {
    platformId: PlatformId
    userId: UserId
    platformRole: ReturnType<typeof ldapGroupMappingUtils.resolveGrants>['platformRole']
    log: FastifyBaseLogger
    entityManager?: EntityManager
}

type ApplyProjectGrantsParams = {
    platformId: PlatformId
    userId: UserId
    projectRoles: ReturnType<typeof ldapGroupMappingUtils.resolveGrants>['projectRoles']
    log: FastifyBaseLogger
    entityManager?: EntityManager
}

type ProjectBelongsToPlatformParams = {
    projectId: string
    platformId: PlatformId
    log: FastifyBaseLogger
}

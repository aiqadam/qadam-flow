import {
    apId,
    ApId,
    assertNotNullOrUndefined,
    ColorName,
    DefaultProjectRole,
    ErrorCode,
    isNil,
    Metadata,
    Project,
    ProjectIcon,
    ProjectId,
    ProjectRole,
    ProjectType,
    QadamFlowError,
    rolePermissions,
    RoleType,
    spreadIfDefined,
    tryCatch,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Brackets, EntityManager, IsNull, Not, ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { transaction } from '../core/db/transaction'
import { getProjectMaxConcurrentJobsKey } from '../database/redis/keys'
import { distributedLock, distributedStore } from '../database/redis-connections'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { userService } from '../user/user-service'
import { projectHooks, ProjectPostCreateContext } from './project-hooks'
import { ProjectMemberEntity } from './project-member.entity'
import { projectRepo } from './project-repo'
import { ProjectRoleEntity } from './project-role.entity'

const projectRoleRepo = repoFactory(ProjectRoleEntity)
const projectMemberRepo = repoFactory(ProjectMemberEntity)

export { projectRepo }

export const projectService = (log: FastifyBaseLogger) => ({
    async create(params: CreateParams): Promise<Project> {
        const { callPostCreateHooks = true, entityManager, postCreateContext, isPrivileged = false, ...rest } = params
        assertCallerMayWriteMaxConcurrentJobs({ requestedMaxConcurrentJobs: rest.maxConcurrentJobs, currentMaxConcurrentJobs: null, isPrivileged })
        const icon = this.createProjectIcon()
        const newProject: NewProject = {
            id: apId(),
            ...rest,
            icon,
            releasesEnabled: false,
        }
        const savedProject = params.type === ProjectType.TEAM
            ? await createTeamProject({
                platformId: params.platformId,
                ownerId: params.ownerId,
                newProject,
                entityManager,
                log,
            })
            : await projectRepo(entityManager).save(newProject)
        if (callPostCreateHooks) {
            await this.callProjectPostCreateHooks(savedProject, postCreateContext)
        }
        return savedProject
    },
    async getOneByOwnerAndPlatform(params: GetOneByOwnerAndPlatformParams): Promise<Project | null> {
        return projectRepo().findOneBy({
            ownerId: params.ownerId,
            platformId: params.platformId,
        })
    },

    async getOne(projectId: ProjectId | undefined): Promise<Project | null> {
        if (isNil(projectId)) {
            return null
        }

        return projectRepo().findOneBy({
            id: projectId,
        })
    },

    async getProjectIdsByPlatform(platformId: string): Promise<string[]> {
        const projects = await projectRepo()
            .createQueryBuilder('project')
            .select('project.id')
            .where({ platformId })
            .orderBy('project.type', 'ASC')
            .addOrderBy('project.displayName', 'ASC')
            .addOrderBy('project.id', 'ASC')
            .getMany()

        return projects.map((project) => project.id)
    },

    async countByPlatformIdAndType({ platformId, type, entityManager }: CountByPlatformIdAndTypeParams): Promise<number> {
        return projectRepo(entityManager).countBy({
            platformId,
            type,
        })
    },

    async update({ projectId, platformId, userId, isPrivileged, request, entityManager }: UpdateProjectParams): Promise<Project> {
        const project = await projectRepo(entityManager).findOneBy({ id: projectId, platformId })
        if (isNil(project) || !(await callerCanAdministerProject({ project, userId, platformId, isPrivileged }))) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: projectId, entityType: 'project' },
            })
        }

        assertCallerMayWriteMaxConcurrentJobs({ requestedMaxConcurrentJobs: request.maxConcurrentJobs, currentMaxConcurrentJobs: project.maxConcurrentJobs, isPrivileged })

        const externalId = request.externalId?.trim() !== '' ? request.externalId : undefined
        await assertExternalIdIsUnique(externalId, projectId)

        const baseUpdate = {
            ...spreadIfDefined('externalId', externalId),
            ...spreadIfDefined('releasesEnabled', request.releasesEnabled),
            ...spreadIfDefined('metadata', request.metadata),
            ...(request.poolId !== undefined ? { poolId: request.poolId } : {}),
            // Only a privileged caller ever *writes* this column. A non-privileged caller
            // reaches here only by echoing the value it read (the gate above rejects anything
            // else), so writing it would be a no-op — except that the row can change between
            // the read at the top of this method and this write, in which case the no-op
            // becomes a revert of an operator's concurrent change. Not writing it closes that
            // window without changing anything for a legitimate caller.
            ...(request.maxConcurrentJobs !== undefined && isPrivileged ? { maxConcurrentJobs: request.maxConcurrentJobs } : {}),
        }

        const teamUpdate = request.type === ProjectType.TEAM ? {
            ...spreadIfDefined('displayName', request.displayName),
            ...spreadIfDefined('icon', request.icon),
        } : {}

        await projectRepo(entityManager).update({ id: projectId, platformId }, { ...baseUpdate, ...teamUpdate })
        // maxConcurrentJobs is read on the rate limiter's hot path through a short-TTL redis
        // cache (rate-limiter-interceptor.ts), not straight from Postgres — an operator lowering
        // a cap for incident response should not have to wait out that TTL, so invalidate the
        // cache entry at the single write site rather than relying on it to expire. This runs
        // after the row has already committed, so a Redis blip here must not fail the request —
        // the caller's update landed either way, and the 30s TTL is the backstop that bounds how
        // stale the rate limiter's view can get if the delete is lost.
        if (request.maxConcurrentJobs !== undefined && isPrivileged) {
            const { error } = await tryCatch(() => distributedStore.delete(getProjectMaxConcurrentJobsKey(projectId)))
            if (!isNil(error)) {
                log.warn({ projectId, err: error }, '[projectService.update] Failed to invalidate maxConcurrentJobs cache entry')
            }
        }
        return this.getOneOrThrow(projectId)
    },

    async getPlatformId(projectId: ProjectId): Promise<string> {
        const result = await projectRepo().createQueryBuilder('project').withDeleted().select('"platformId"').where({
            id: projectId,
        }).getRawOne()
        const platformId = result?.platformId
        if (isNil(platformId)) {
            throw new Error(`Platform ID for project ${projectId} is undefined in webhook.`)
        }
        return platformId
    },
    async getOneOrThrow(projectId: ProjectId): Promise<Project> {
        const project = await this.getOne(projectId)

        if (isNil(project)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: projectId,
                    entityType: 'project',
                },
            })
        }

        return project
    },
    async exists({ projectId, isSoftDeleted }: ExistsParams): Promise<boolean> {
        const project = await projectRepo().findOne({
            where: {
                id: projectId,
                deleted: isSoftDeleted ? Not(IsNull()) : IsNull(),
            },
            withDeleted: true,
        })
        return !isNil(project)
    },
    async getUserProjectOrThrow(userId: UserId): Promise<Project> {
        const user = await userService(log).getOneOrFail({ id: userId })
        assertNotNullOrUndefined(user.platformId, 'platformId is undefined')
        const projects = await this.getAllForUser({
            platformId: user.platformId,
            userId,
            isPrivileged: userService(log).isUserPrivileged(user),
        })
        if (isNil(projects) || projects.length === 0) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: userId,
                    entityType: 'user',
                },
            })
        }
        return projects.find((p) => p.ownerId === userId && p.type === ProjectType.PERSONAL) ?? projects[0]
    },

    async getAllForUser(params: GetAllForUserParams): Promise<Project[]> {
        assertNotNullOrUndefined(params.platformId, 'platformId is undefined')

        const queryBuilder = projectRepo()
            .createQueryBuilder('project')
            .where('project."platformId" = :platformId', { platformId: params.platformId })
            .andWhere('project.deleted IS NULL')
            .orderBy('project.type', 'ASC')
            .addOrderBy('project.displayName', 'ASC')
            .addOrderBy('project.id', 'ASC')

        if (params.displayName) {
            queryBuilder.andWhere('project."displayName" ILIKE :displayName', { displayName: `%${params.displayName}%` })
        }

        await applyProjectsAccessFilters(queryBuilder, params)

        return queryBuilder.getMany()
    },
    async userHasProjects(params: GetAllForUserParams): Promise<boolean> {
        assertNotNullOrUndefined(params.platformId, 'platformId is undefined')

        const queryBuilder = projectRepo()
            .createQueryBuilder('project')
            .where('project."platformId" = :platformId', { platformId: params.platformId })

        await applyProjectsAccessFilters(queryBuilder, params)

        return queryBuilder.getExists()
    },
    async addProjectToPlatform({ projectId, platformId }: AddProjectToPlatformParams): Promise<void> {
        const query = {
            id: projectId,
        }

        const update = {
            platformId,
        }

        await projectRepo().update(query, update)
    },

    async softDelete({ projectId, platformId, userId, isPrivileged }: SoftDeleteParams): Promise<void> {
        const project = await projectRepo().findOneBy({ id: projectId, platformId })
        // Return the same 404 for both "not found" and "not authorized" to avoid ID enumeration.
        if (isNil(project) || !(await callerCanAdministerProject({ project, userId, platformId, isPrivileged }))) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: projectId,
                    entityType: 'project',
                },
            })
        }
        // The mark-deleted write and the postSoftDelete sweep (e.g. alert-row cleanup) must
        // land together: softDelete uses deleted-IS-NULL semantics for its own lookup, so a
        // partial failure would make the project unreachable to any retry that re-runs the sweep.
        await transaction(async (entityManager) => {
            await projectRepo(entityManager).update({ id: projectId, platformId }, { deleted: new Date().toISOString() })
            await projectHooks.get(log).postSoftDelete({ entityManager, projectId })
        })
    },

    async getByPlatformIdAndExternalId({
        platformId,
        externalId,
    }: GetByPlatformIdAndExternalIdParams): Promise<Project | null> {
        return projectRepo().findOneBy({
            platformId,
            externalId,
        })
    },
    createProjectIcon: ()=>{
        const colors = Object.values(ColorName)
        const icon: ProjectIcon = {
            color: colors[Math.floor(Math.random() * colors.length)],
        }
        return icon
    },
    callProjectPostCreateHooks: async (savedProject: Project, context?: ProjectPostCreateContext)=>{
        await projectHooks.get(log).postCreate(savedProject, context)
    },
    async getProjectRoleForUser(params: GetProjectRoleForUserParams): Promise<ProjectRole | null> {
        const { userId, projectId, platformId } = params
        const row = await projectMemberRepo()
            .createQueryBuilder('pm')
            .innerJoin('project_role', 'pr', 'pr.id = pm."projectRoleId"')
            .select([
                'pr.id AS id',
                'pr.name AS name',
                'pr.permissions AS permissions',
                'pr."platformId" AS "platformId"',
                'pr.type AS type',
                'pr.created AS created',
                'pr.updated AS updated',
            ])
            .where('pm."userId" = :userId AND pm."projectId" = :projectId AND pm."platformId" = :platformId', {
                userId,
                projectId,
                platformId,
            })
            .getRawOne<ProjectRole>()
        return row ?? null
    },
    // Revalidates alert receivers (and anything else keyed by email rather than userId) against
    // current membership in one round trip. `add()`'s per-receiver getProjectRoleForUser check is
    // right for a single grant, but MAX_ALERT_RECEIVERS receivers would mean 50 round trips here.
    //
    // "Still a member" is deliberately narrower than "a project_member row exists": project_member
    // has no FK to user (see 1784284221314-AddProjectMemberTable) and userService#removeFromPlatform
    // detaches a user by nulling user.platformId rather than deleting the user or the membership row.
    // So a project_member row alone can outlive the offboarding — it has to be joined against a user
    // row whose platformId still matches this project's platform to prove the grant is still live.
    // For PERSONAL projects there is no project_member row for the owner (see
    // applyProjectsAccessFilters above), so membership instead means "still the project owner and
    // still attached to this platform."
    async filterActiveMemberEmails({ project, emails }: FilterActiveMemberEmailsParams): Promise<string[]> {
        if (emails.length === 0) {
            return []
        }
        const normalizedEmails = emails.map((email) => email.toLowerCase().trim())
        const { id: projectId, platformId } = project

        if (project.type === ProjectType.PERSONAL) {
            const owner = await userService(log).get({ id: project.ownerId })
            if (isNil(owner) || owner.platformId !== platformId) {
                return []
            }
            const identity = await userIdentityService(log).getOneOrFail({ id: owner.identityId })
            const ownerEmail = identity.email.toLowerCase().trim()
            return normalizedEmails.filter((email) => email === ownerEmail)
        }

        const rows = await projectMemberRepo()
            .createQueryBuilder('pm')
            .innerJoin('user', 'usr', 'usr.id = pm."userId" AND usr."platformId" = :platformId', { platformId })
            .innerJoin('user_identity', 'ui', 'ui.id = usr."identityId"')
            .where('pm."projectId" = :projectId', { projectId })
            .andWhere('pm."platformId" = :platformId', { platformId })
            .andWhere('LOWER(ui.email) IN (:...emails)', { emails: normalizedEmails })
            .select('LOWER(ui.email)', 'email')
            .getRawMany<{ email: string }>()
        const activeMemberEmails = new Set(rows.map((row) => row.email))

        return normalizedEmails.filter((email) => activeMemberEmails.has(email))
    },
})


export async function applyProjectsAccessFilters<T extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<T>,
    params: ApplyProjectsAccessFiltersParams,
): Promise<void> {
    const { platformId, userId, isPrivileged } = params
    if (isPrivileged) {
        return
    }

    queryBuilder.andWhere(new Brackets(qb => {
        qb.where(
            'project."ownerId" = :userId AND project.type = :personalType',
            { userId, personalType: ProjectType.PERSONAL },
        ).orWhere(
            'project.id IN (SELECT "projectId" FROM project_member WHERE "userId" = :userId AND "platformId" = :platformId)',
            { userId, platformId },
        )
    }))
}
async function callerCanAdministerProject(params: CallerCanAdministerProjectParams): Promise<boolean> {
    const { project, userId, platformId, isPrivileged } = params
    if (isPrivileged) {
        return true
    }
    if (project.ownerId === userId) {
        return true
    }
    const adminMembership = await projectMemberRepo()
        .createQueryBuilder('pm')
        .innerJoin('project_role', 'pr', 'pr.id = pm."projectRoleId"')
        .where('pm."userId" = :userId AND pm."projectId" = :projectId AND pm."platformId" = :platformId', {
            userId,
            projectId: project.id,
            platformId,
        })
        .andWhere('pr.name = :roleName', { roleName: DefaultProjectRole.ADMIN })
        .getOne()
    return !isNil(adminMembership)
}

// The cap check reads a system prop, not `platform.plan.*` (edition-safety.md forbids
// plan/edition-derived gating), and only enters the distributed lock when a finite cap is
// actually configured, so the default (unlimited, unconfigured) path never pays a Redis round
// trip. Count + insert still need the lock together once a cap applies, otherwise two concurrent
// requests can both read "under the cap" and both insert (CLAUDE.md's concurrency rule).
//
// No current caller passes an `entityManager` into project creation for TEAM projects, so
// `saveTeamProject`'s insert autocommits on its own inside the lock today. If a future caller ever
// wraps `create()` in an outer `transaction()`, the lock released here would no longer bound the
// count+insert: the outer transaction could still be uncommitted (and its row invisible to a
// concurrent count) after this function returns and the lock is released, reopening the exact
// race the lock exists to close. Any such caller must pass the *same* entityManager through to
// both the count and the insert, inside a lock that outlives the transaction's commit.
async function createTeamProject(params: CreateTeamProjectParams): Promise<Project> {
    const { platformId, ownerId, newProject, entityManager, log } = params
    const maxTeamProjects = getMaxTeamProjectsPerPlatform()
    if (isNil(maxTeamProjects)) {
        return saveTeamProject({ platformId, ownerId, newProject, entityManager })
    }
    return distributedLock(log).runExclusive({
        key: `team-project-limit:${platformId}`,
        timeoutInSeconds: 10,
        fn: async () => {
            await assertTeamProjectsLimitNotExceeded({ platformId, maxTeamProjects, entityManager, log })
            return saveTeamProject({ platformId, ownerId, newProject, entityManager })
        },
    })
}

async function saveTeamProject(params: SaveTeamProjectParams): Promise<Project> {
    const { platformId, ownerId, newProject, entityManager } = params
    await ensureDefaultProjectRoles(platformId, entityManager)
    const savedProject = await projectRepo(entityManager).save(newProject)
    await addCreatorAsProjectAdmin({
        projectId: savedProject.id,
        userId: ownerId,
        platformId,
        entityManager,
    })
    return savedProject
}

// `system.getNumber()` returns `null` for both "unset" and an unparseable value. Startup
// validation (system-validator.ts's numberValidator entry for this prop) flags a non-numeric
// AP_MAX_TEAM_PROJECTS_PER_PLATFORM in the `validateEnvPropsOnStartup` warning log — same as every
// other numberValidator-backed prop (e.g. MAX_RECORDS_PER_TABLE), it only warns, it does not
// throw and does not stop the process — so a malformed value still reaches this function at
// runtime. It must fail open to "no cap", never closed to "0 team projects allowed
// platform-wide" (the non-exhaustive-mapping trap #147 hit).
function getMaxTeamProjectsPerPlatform(): number | null {
    const configuredValue = system.getNumber(AppSystemProp.MAX_TEAM_PROJECTS_PER_PLATFORM)
    if (isNil(configuredValue) || configuredValue <= 0) {
        return null
    }
    return configuredValue
}

async function assertTeamProjectsLimitNotExceeded(params: AssertTeamProjectsLimitNotExceededParams): Promise<void> {
    const { platformId, maxTeamProjects, entityManager, log } = params
    // TEAM-only, not platform-wide: PERSONAL projects are created automatically as a side effect
    // of user onboarding (user-service.ts), outside the caller's control. Counting them toward
    // this cap would risk blocking new-user signup once a platform is at capacity, which is a much
    // worse failure mode than the abuse case (self-service team-project creation) this cap exists
    // to bound.
    const currentTeamProjects = await projectService(log).countByPlatformIdAndType({
        platformId,
        type: ProjectType.TEAM,
        entityManager,
    })
    if (currentTeamProjects >= maxTeamProjects) {
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: {
                resource: 'team_projects',
                limit: maxTeamProjects,
            },
        })
    }
}

async function addCreatorAsProjectAdmin(params: AddCreatorAsProjectAdminParams): Promise<void> {
    const { projectId, userId, platformId, entityManager } = params
    const adminRole = await projectRoleRepo(entityManager).findOneByOrFail({
        platformId,
        name: DefaultProjectRole.ADMIN,
        type: RoleType.DEFAULT,
    })
    await projectMemberRepo(entityManager).upsert({
        id: apId(),
        userId,
        projectId,
        projectRoleId: adminRole.id,
        platformId,
    }, ['userId', 'projectId'])
}

// TODO: lazy-seeds default roles on first TEAM-project create. A migration that backfills all
// existing platforms + a hook on platform.create would be cleaner (single source of truth,
// removes the per-create query), but keeps the fix small and colocated with the feature.
async function ensureDefaultProjectRoles(platformId: string, entityManager?: EntityManager): Promise<void> {
    const repo = projectRoleRepo(entityManager)
    const existing = await repo.find({ where: { platformId, type: RoleType.DEFAULT } })
    const existingNames = new Set(existing.map(r => r.name))
    const rows = Object.values(DefaultProjectRole)
        .filter(name => !existingNames.has(name))
        .map(name => ({
            id: apId(),
            name,
            permissions: rolePermissions[name],
            platformId,
            type: RoleType.DEFAULT,
        }))
    if (rows.length > 0) {
        await repo.insert(rows)
    }
}

// `maxConcurrentJobs` is enforced by the rate limiter (rate-limiter-interceptor.ts, #201) — it is
// no longer a harmless, dead column. `POST /v1/projects` is open to every authenticated USER
// (publicPlatform([PrincipalType.USER]), adminOnly: false), and on update the only gate is
// callerCanAdministerProject, which is true for the project owner or any member with the project
// ADMIN role — neither is a platform admin/operator. Without this check, any user could set their
// own project's cap to an arbitrarily high value and starve every other project sharing the same
// workers, since the pool is the deployment's only per-project fairness guard.
//
// The gate has to trigger on a *change*, not on the field merely being present, in both
// directions:
// - Gating on "non-nil" alone still let a non-privileged caller null out an operator-set cap
//   (isNil(null) is true), which is the same escalation the other way — clearing someone else's
//   throttle.
// - Gating on presence at all 403s unrelated saves: the web client always sends
//   `maxConcurrentJobs` on every project update (project-collection.ts), seeded from the current
//   value by a form whose input only renders for platform admins — so a MEMBER-role project
//   owner renaming their own project, toggling releases, or saving the pieces filter would get a
//   403 on any project that already has a cap, entirely unrelated to what they were trying to do.
// Comparing against the already-loaded row lets an unchanged echo through (fixing the second
// problem) while still rejecting a non-privileged caller raising *or* clearing the value (fixing
// the first) — only an actual change requires privilege. On create there is no existing row, so
// "unset" (`null`) is the only value that doesn't require privilege.
// `currentMaxConcurrentJobs` is `number | null | undefined` because `Nullable` in
// `packages/shared` is `.nullable().optional()`, so the Project model's field is optional as
// well as nullable. The two spellings of "no override" are normalised with `?? null` before the
// comparison — but only *after* the `undefined` check on the request, where `undefined`
// means "the field was absent from the body" rather than "no override", and must not compare
// equal to a stored `null`.
function assertCallerMayWriteMaxConcurrentJobs({ requestedMaxConcurrentJobs, currentMaxConcurrentJobs, isPrivileged }: { requestedMaxConcurrentJobs: number | null | undefined, currentMaxConcurrentJobs: number | null | undefined, isPrivileged: boolean }): void {
    if (isPrivileged || requestedMaxConcurrentJobs === undefined) {
        return
    }
    if ((requestedMaxConcurrentJobs ?? null) === (currentMaxConcurrentJobs ?? null)) {
        return
    }
    throw new QadamFlowError({
        code: ErrorCode.AUTHORIZATION,
        params: {
            message: 'Only a platform admin or operator can change maxConcurrentJobs',
        },
    })
}

async function assertExternalIdIsUnique(externalId: string | undefined | null, projectId: ProjectId): Promise<void> {
    if (!isNil(externalId)) {
        const externalIdAlreadyExists = await projectRepo().existsBy({
            id: Not(projectId),
            externalId,
        })

        if (externalIdAlreadyExists) {
            throw new QadamFlowError({
                code: ErrorCode.PROJECT_EXTERNAL_ID_ALREADY_EXISTS,
                params: {
                    externalId,
                },
            })
        }
    }
}

type GetAllForUserParams = {
    platformId: string
    userId: string
    isPrivileged: boolean
    displayName?: string
}

type GetOneByOwnerAndPlatformParams = {
    ownerId: UserId
    platformId: string
}

type ExistsParams = {
    projectId: ProjectId
    isSoftDeleted?: boolean
}

type UpdateTeamProjectParams = {
    type: ProjectType.TEAM
    displayName?: string
    externalId?: string
    releasesEnabled?: boolean
    metadata?: Metadata
    poolId?: string | null
    maxConcurrentJobs?: number | null
    icon?: ProjectIcon
}

type UpdatePersonalProjectParams = {
    type: ProjectType.PERSONAL
    externalId?: string
    releasesEnabled?: boolean
    metadata?: Metadata
    poolId?: string | null
    maxConcurrentJobs?: number | null
}

type UpdateParams = UpdateTeamProjectParams | UpdatePersonalProjectParams

type CreateParams = {
    ownerId: UserId
    displayName: string
    type: ProjectType
    platformId: string
    externalId?: string
    metadata?: Metadata
    maxConcurrentJobs?: number
    isPrivileged?: boolean
    callPostCreateHooks?: boolean
    postCreateContext?: ProjectPostCreateContext
    entityManager?: EntityManager
}

type GetByPlatformIdAndExternalIdParams = {
    platformId: string
    externalId: string
}

type AddProjectToPlatformParams = {
    projectId: ProjectId
    platformId: ApId
}

type SoftDeleteParams = {
    projectId: ProjectId
    platformId: string
    userId: string
    isPrivileged: boolean
}

type CallerCanAdministerProjectParams = {
    project: Project
    userId: string
    platformId: string
    isPrivileged: boolean
}

type GetProjectRoleForUserParams = {
    userId: string
    projectId: string
    platformId: string
}

type FilterActiveMemberEmailsParams = {
    project: Project
    emails: string[]
}

type UpdateProjectParams = {
    projectId: ProjectId
    platformId: string
    userId: string
    isPrivileged: boolean
    request: UpdateParams
    entityManager?: EntityManager
}

type NewProject = Omit<Project, 'created' | 'updated' | 'deleted'>

type ApplyProjectsAccessFiltersParams = {
    platformId: string
    userId: string
    isPrivileged: boolean
}

type AddCreatorAsProjectAdminParams = {
    projectId: string
    userId: string
    platformId: string
    entityManager?: EntityManager
}

type CreateTeamProjectParams = {
    platformId: string
    ownerId: string
    newProject: NewProject
    entityManager?: EntityManager
    log: FastifyBaseLogger
}

type SaveTeamProjectParams = {
    platformId: string
    ownerId: string
    newProject: NewProject
    entityManager?: EntityManager
}

type AssertTeamProjectsLimitNotExceededParams = {
    platformId: string
    maxTeamProjects: number
    entityManager?: EntityManager
    log: FastifyBaseLogger
}

type CountByPlatformIdAndTypeParams = {
    platformId: string
    type: ProjectType
    entityManager?: EntityManager
}

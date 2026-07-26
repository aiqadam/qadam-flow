import {
    apId,
    ApId,
    assertNotNullOrUndefined,
    ColorName,
    DefaultProjectRole,
    ErrorCode,
    isNil,
    Metadata,
    PlatformUsageMetric,
    Project,
    ProjectIcon,
    ProjectId,
    ProjectRole,
    ProjectType,
    QadamFlowError,
    rolePermissions,
    RoleType,
    spreadIfDefined,
    TeamProjectsLimit,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Brackets, EntityManager, IsNull, Not, ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { platformService } from '../platform/platform.service'
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
        const { callPostCreateHooks = true, entityManager, postCreateContext, ...rest } = params
        const icon = this.createProjectIcon()
        const newProject: NewProject = {
            id: apId(),
            ...rest,
            icon,
            releasesEnabled: false,
        }
        const savedProject = params.type === ProjectType.TEAM
            ? await createTeamProject({ platformId: params.platformId, ownerId: params.ownerId, newProject, entityManager, log })
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

    async countByPlatformIdAndType(platformId: string, type: ProjectType): Promise<number> {
        return projectRepo().countBy({
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

        const externalId = request.externalId?.trim() !== '' ? request.externalId : undefined
        await assertExternalIdIsUnique(externalId, projectId)

        const baseUpdate = {
            ...spreadIfDefined('externalId', externalId),
            ...spreadIfDefined('releasesEnabled', request.releasesEnabled),
            ...spreadIfDefined('metadata', request.metadata),
            ...(request.poolId !== undefined ? { poolId: request.poolId } : {}),
            ...(request.maxConcurrentJobs !== undefined ? { maxConcurrentJobs: request.maxConcurrentJobs } : {}),
        }

        const teamUpdate = request.type === ProjectType.TEAM ? {
            ...spreadIfDefined('displayName', request.displayName),
            ...spreadIfDefined('icon', request.icon),
        } : {}

        await projectRepo(entityManager).update({ id: projectId, platformId }, { ...baseUpdate, ...teamUpdate })
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
        await projectRepo().update({ id: projectId, platformId }, { deleted: new Date().toISOString() })
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

async function createTeamProject(params: CreateTeamProjectParams): Promise<Project> {
    const { platformId, ownerId, newProject, entityManager, log } = params
    return distributedLock(log).runExclusive({
        key: `team-project-limit:${platformId}`,
        timeoutInSeconds: 10,
        fn: async () => {
            await assertTeamProjectsLimitNotExceeded({ platformId, entityManager, log })
            await ensureDefaultProjectRoles(platformId, entityManager)
            const savedProject = await projectRepo(entityManager).save(newProject)
            await addCreatorAsProjectAdmin({
                projectId: savedProject.id,
                userId: ownerId,
                platformId,
                entityManager,
            })
            return savedProject
        },
    })
}

async function assertTeamProjectsLimitNotExceeded(params: AssertTeamProjectsLimitNotExceededParams): Promise<void> {
    const { platformId, entityManager, log } = params
    const { teamProjectsLimit } = await platformService(log).getPlanOrThrow(platformId)
    if (teamProjectsLimit === TeamProjectsLimit.UNLIMITED) {
        return
    }
    const maxTeamProjects = teamProjectsLimit === TeamProjectsLimit.ONE ? 1 : 0
    const currentTeamProjects = await projectRepo(entityManager).countBy({
        platformId,
        type: ProjectType.TEAM,
    })
    if (currentTeamProjects >= maxTeamProjects) {
        throw new QadamFlowError({
            code: ErrorCode.QUOTA_EXCEEDED,
            params: {
                metric: PlatformUsageMetric.TEAM_PROJECTS,
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

type AssertTeamProjectsLimitNotExceededParams = {
    platformId: string
    entityManager?: EntityManager
    log: FastifyBaseLogger
}

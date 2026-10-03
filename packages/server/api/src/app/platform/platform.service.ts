import {
    apId,
    AuthenticationResponse,
    ErrorCode,
    FilteredQadamBehavior,
    isNil,
    Platform,
    PlatformId,
    PlatformPlanLimits,
    PlatformRole,
    PlatformUsage,
    PlatformWithoutFederatedAuth,
    PlatformWithoutSensitiveData,
    ProjectType,
    QadamFlowError,
    spreadIfDefined,
    SsoDomainVerification,
    TeamProjectsLimit,
    UpdatePlatformRequestBody,
    UserId,
    UserStatus,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { EntityManager } from 'typeorm'
import { authenticationUtils } from '../authentication/authentication-utils'
import { userIdentityRepository, userIdentityService } from '../authentication/user-identity/user-identity-service'
import { repoFactory } from '../core/db/repo-factory'
import { transaction } from '../core/db/transaction'
import { distributedLock } from '../database/redis-connections'
import { defaultTheme } from '../flags/theme'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { PlatformEntity } from './platform.entity'

export const platformRepo = repoFactory<Platform>(PlatformEntity)

export const platformService = (log: FastifyBaseLogger) => ({
    async listPlatformsForIdentityWithAtleastProject(params: ListPlatformsForIdentityParams): Promise<PlatformWithoutSensitiveData[]> {
        const users = await userService(log).getByIdentityId({ identityId: params.identityId })

        const platformsWithProjects = await Promise.all(users.map(async (user) => {
            if (isNil(user.platformId) || user.status === UserStatus.INACTIVE) {
                return null
            }
            const hasProjects = await projectService(log).userHasProjects({
                platformId: user.platformId,
                userId: user.id,
                isPrivileged: userService(log).isUserPrivileged(user),
            })
            return hasProjects ? user.platformId : null
        }))

        const platforms = await Promise.all(platformsWithProjects.filter((platformId) => !isNil(platformId)).map((platformId) => this.getOneWithPlanOrThrow(platformId)))
        return platforms
    },
    async create(params: AddParams): Promise<PlatformWithoutFederatedAuth> {
        const {
            ownerId,
            name,
            primaryColor,
            logoIconUrl,
            fullLogoUrl,
            favIconUrl,
            entityManager,
        } = params

        const newPlatform: NewPlatform = {
            id: apId(),
            ownerId,
            name,
            primaryColor: primaryColor ?? defaultTheme.colors.primary.default,
            logoIconUrl: logoIconUrl ?? defaultTheme.logos.logoIconUrl,
            fullLogoUrl: fullLogoUrl ?? defaultTheme.logos.fullLogoUrl,
            favIconUrl: favIconUrl ?? defaultTheme.logos.favIconUrl,
            emailAuthEnabled: true,
            filteredQadamNames: [],
            enforceAllowedAuthDomains: false,
            allowedAuthDomains: [],
            filteredQadamBehavior: FilteredQadamBehavior.BLOCKED,
            federatedAuthProviders: { saml: null },
            pinnedQadams: [],
            allowedEmbedOrigins: [],
            googleAuthEnabled: true,
        }

        const savedPlatform = await platformRepo(entityManager).save(newPlatform)
        const ownerAttached = await userService(log).addOwnerToPlatform({
            id: ownerId,
            platformId: savedPlatform.id,
            entityManager,
        })
        if (!ownerAttached) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Platform owner is already attached to another platform',
                },
            })
        }

        log.info({ platformId: savedPlatform.id, ownerId }, 'Platform created')
        return stripFederatedAuth(savedPlatform)
    },
    async createPlatformWithProject({ identityId, name, invalidatePreviousTokens }: CreatePlatformWithProjectParams): Promise<AuthenticationResponse> {
        // signUp's no-platform branch already bootstraps a platformId:null row for this identity
        // (authentication.service.ts) so GET /v1/users/me has something to answer with during the
        // onboarding window — reuse it rather than inserting an orphaned second one. Reusing it
        // is not required by any unique constraint: (platformId, identityId) is a plain unique
        // index, and Postgres treats every NULL platformId as distinct, so a second insert would
        // not collide. `create` below still promotes it to ADMIN and assigns the real platformId
        // via `addOwnerToPlatform`, so a pre-signUp caller with no such row yet (there is none in
        // this codebase, but nothing prevents one) still works.
        //
        // Two concurrent onboarding calls for the same identity (two tabs, or any API client)
        // must not both promote the same existingUser row, which would strand one of the two
        // platforms with an owner whose own platformId points at the other one. The database
        // enforces that on its own (see claimOnboardingUserAndCreatePlatform); the lock only
        // keeps the two calls from contending for the same row lock in the first place.
        return distributedLock(log).runExclusive({
            key: `create-platform-with-project:${identityId}`,
            timeoutInSeconds: 10,
            fn: () => claimOnboardingUserAndCreatePlatform({ identityId, name, invalidatePreviousTokens, log }),
        })
    },
    async getAll(): Promise<PlatformWithoutFederatedAuth[]> {
        return platformRepo().find()
    },
    async getOldestPlatform(): Promise<PlatformWithoutFederatedAuth | null> {
        return platformRepo().findOne({
            where: {},
            order: {
                created: 'ASC',
            },
        })
    },
    async update(params: UpdateParams): Promise<PlatformWithoutFederatedAuth> {
        const platform = params.federatedAuthProviders !== undefined
            ? await this.getOneWithFederatedAuthOrThrow(params.id)
            : await this.getOneOrThrow(params.id)
        const federatedAuthProviders = hasFederatedAuth(platform)
            ? {
                ...platform.federatedAuthProviders,
                ...(params.federatedAuthProviders ?? {}),
            }
            : undefined
        const updatedPlatform = {
            ...platform,
            ...spreadIfDefined('federatedAuthProviders', federatedAuthProviders),
            ...spreadIfDefined('name', params.name),
            ...spreadIfDefined('primaryColor', params.primaryColor),
            ...spreadIfDefined('logoIconUrl', params.logoIconUrl),
            ...spreadIfDefined('fullLogoUrl', params.fullLogoUrl),
            ...spreadIfDefined('favIconUrl', params.favIconUrl),
            ...spreadIfDefined('filteredQadamNames', params.filteredQadamNames),
            ...spreadIfDefined('filteredQadamBehavior', params.filteredQadamBehavior),
            ...spreadIfDefined('googleAuthEnabled', params.googleAuthEnabled),
            ...spreadIfDefined('emailAuthEnabled', params.emailAuthEnabled),
            ...spreadIfDefined(
                'enforceAllowedAuthDomains',
                params.enforceAllowedAuthDomains,
            ),
            ...spreadIfDefined('allowedAuthDomains', params.allowedAuthDomains),
            ...spreadIfDefined('allowedEmbedOrigins', params.allowedEmbedOrigins),
            ...spreadIfDefined('ssoDomain', params.ssoDomain),
            ...spreadIfDefined('ssoDomainVerification', params.ssoDomainVerification),
            ...spreadIfDefined('pinnedQadams', params.pinnedQadams),
        }
        log.info({ platformId: params.id }, 'Platform updated')
        const saved = await platformRepo().save(updatedPlatform)
        return stripFederatedAuth(saved)
    },
    async getOneOrThrow(id: PlatformId): Promise<PlatformWithoutFederatedAuth> {
        return platformRepo().findOneByOrFail({ id })
    },
    async getOne(id: PlatformId): Promise<PlatformWithoutFederatedAuth | null> {
        return platformRepo().findOneBy({ id })
    },
    async getOneWithFederatedAuthOrThrow(id: PlatformId): Promise<Platform> {
        return platformRepo()
            .createQueryBuilder('platform')
            .addSelect('platform.federatedAuthProviders')
            .where({ id })
            .getOneOrFail()
    },
    async hasSamlConfigured(id: PlatformId): Promise<boolean> {
        const result = await platformRepo()
            .createQueryBuilder('platform')
            .select('platform."federatedAuthProviders"', 'federatedAuthProviders')
            .where({ id })
            .getRawOne<{ federatedAuthProviders: { saml?: unknown } | null }>()
        return !isNil(result?.federatedAuthProviders?.saml)
    },
    async getOneWithPlan(id: PlatformId): Promise<PlatformWithoutSensitiveData | null> {
        const platform = await this.getOne(id)
        if (isNil(platform)) {
            return null
        }
        const [samlConfigured, plan, usage] = await Promise.all([
            this.hasSamlConfigured(id),
            getPlan(log, platform),
            getUsage(log, platform),
        ])
        return {
            ...platform,
            federatedAuthProviders: { saml: samlConfigured ? {} : null },
            usage,
            plan,
        }
    },
    async getOneWithPlanOrThrow(id: PlatformId): Promise<Omit<PlatformWithoutSensitiveData, 'usage'>> {
        const platform = await this.getOneOrThrow(id)
        const [samlConfigured, plan] = await Promise.all([
            this.hasSamlConfigured(id),
            getPlan(log, platform),
        ])
        return {
            ...platform,
            federatedAuthProviders: { saml: samlConfigured ? {} : null },
            plan,
        }
    },
    async getOneWithPlanAndUsageOrThrow(id: PlatformId): Promise<PlatformWithoutSensitiveData> {
        const platform = await this.getOneOrThrow(id)
        const [samlConfigured, usage, plan] = await Promise.all([
            this.hasSamlConfigured(id),
            getUsage(log, platform),
            getPlan(log, platform),
        ])
        return {
            ...platform,
            federatedAuthProviders: { saml: samlConfigured ? {} : null },
            usage,
            plan,
        }
    },
})

async function getUsage(_log: FastifyBaseLogger, _platform: PlatformWithoutFederatedAuth): Promise<PlatformUsage | undefined> {
    return undefined
}

async function getPlan(_log: FastifyBaseLogger, _platform: PlatformWithoutFederatedAuth): Promise<PlatformPlanLimits> {
    return {
        tablesEnabled: true,
        embeddingEnabled: false,
        agentsEnabled: true,
        aiProvidersEnabled: true,
        chatEnabled: true,
        dataManipulationEnabled: false,
        globalConnectionsEnabled: false,
        customRolesEnabled: false,
        environmentsEnabled: false,
        eventStreamingEnabled: false,
        analyticsEnabled: true,
        showPoweredBy: false,
        auditLogEnabled: false,
        managePiecesEnabled: false,
        manageTemplatesEnabled: false,
        customAppearanceEnabled: false,
        teamProjectsLimit: TeamProjectsLimit.UNLIMITED,
        projectRolesEnabled: false,
        ssoEnabled: false,
        secretManagersEnabled: false,
        scimEnabled: false,
        stripeCustomerId: undefined,
        stripeSubscriptionId: undefined,
        stripeSubscriptionStatus: undefined,
        dedicatedWorkers: null,
        canary: false,
        customDomainsEnabled: false,
        stripeSubscriptionStartDate: 0,
        stripeSubscriptionEndDate: 0,
    }
}

// Every write of the claim commits together or not at all, so a failure part-way never leaves a
// platform without its project or owner. The onboarding user row is row-locked for the whole
// transaction: a concurrent claim for the same identity waits, then finds the row already attached
// and inserts its own — the same outcome as when the distributed lock serializes the two calls,
// but enforced by the database rather than by the lock's lease.
async function claimOnboardingUserAndCreatePlatform({ identityId, name, invalidatePreviousTokens, log }: ClaimOnboardingUserAndCreatePlatformParams): Promise<AuthenticationResponse> {
    const { claimedUser, platform, defaultProject } = await transaction(async (entityManager) => {
        const existingUser = await userService(log).getUnattachedByIdentityForUpdate({ identityId, entityManager })
        const claimedUser = existingUser ?? await userService(log).create({
            identityId,
            platformRole: PlatformRole.ADMIN,
            platformId: null,
            entityManager,
        })
        const createdPlatform = await platformService(log).create({ ownerId: claimedUser.id, name, entityManager })
        const createdProject = await projectService(log).create({
            displayName: `${name}'s Project`,
            ownerId: claimedUser.id,
            platformId: createdPlatform.id,
            type: ProjectType.PERSONAL,
            callPostCreateHooks: false,
            entityManager,
        })
        if (invalidatePreviousTokens) {
            await userIdentityRepository(entityManager).update(identityId, {
                tokenVersion: nanoid(),
            })
        }
        return { claimedUser, platform: createdPlatform, defaultProject: createdProject }
    })
    await projectService(log).callProjectPostCreateHooks(defaultProject)
    await authenticationUtils(log).sendTelemetry({
        identity: await userIdentityService(log).getOneOrFail({ id: identityId }),
        user: claimedUser,
        projectId: defaultProject.id,
    })
    return authenticationUtils(log).getProjectAndToken({
        userId: claimedUser.id,
        platformId: platform.id,
        projectId: defaultProject.id,
    })
}

function stripFederatedAuth(platform: Platform): PlatformWithoutFederatedAuth {
    const { federatedAuthProviders: _omitted, ...rest } = platform
    return rest
}

function hasFederatedAuth(platform: Platform | PlatformWithoutFederatedAuth): platform is Platform {
    return 'federatedAuthProviders' in platform
}

type AddParams = {
    ownerId: UserId
    entityManager?: EntityManager
    name: string
    primaryColor?: string
    logoIconUrl?: string
    fullLogoUrl?: string
    favIconUrl?: string
}

type NewPlatform = Omit<Platform, 'created' | 'updated'>

type UpdateParams = UpdatePlatformRequestBody & {
    id: PlatformId
    plan?: Partial<PlatformPlanLimits>
    logoIconUrl?: string
    fullLogoUrl?: string
    favIconUrl?: string
    ssoDomain?: string | null
    ssoDomainVerification?: SsoDomainVerification | null
}

type CreatePlatformWithProjectParams = {
    identityId: string
    name: string
    invalidatePreviousTokens: boolean
}

type ClaimOnboardingUserAndCreatePlatformParams = CreatePlatformWithProjectParams & {
    log: FastifyBaseLogger
}

type ListPlatformsForIdentityParams = {
    identityId: string
}

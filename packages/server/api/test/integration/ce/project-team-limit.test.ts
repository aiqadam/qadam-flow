import { PlatformUsageMetric, ProjectType, TeamProjectsLimit } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { system } from '../../../src/app/helper/system/system'
import { projectService } from '../../../src/app/project/project-service'
import { createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

const teamProjectsLimitOverrides = vi.hoisted(() => new Map<string, TeamProjectsLimit>())

vi.mock('../../../src/app/platform/platform.service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/app/platform/platform.service')>()
    return {
        ...actual,
        platformService: (log: Parameters<typeof actual.platformService>[0]) => {
            const actualService = actual.platformService(log)
            return {
                ...actualService,
                getPlanOrThrow: async (platformId: string) => {
                    const plan = await actualService.getPlanOrThrow(platformId)
                    const overriddenLimit = teamProjectsLimitOverrides.get(platformId)
                    return overriddenLimit ? { ...plan, teamProjectsLimit: overriddenLimit } : plan
                },
            }
        },
    }
})

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterEach(() => {
    teamProjectsLimitOverrides.clear()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Project team-projects limit enforcement (CE)', () => {
    it('rejects creating a second TEAM project once the platform plan caps teamProjectsLimit at ONE', async () => {
        const ctx = await createTestContext(app!, { project: { type: ProjectType.PERSONAL } })
        teamProjectsLimitOverrides.set(ctx.platform.id, TeamProjectsLimit.ONE)

        const first = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(first.statusCode).toBe(StatusCodes.CREATED)

        const second = await ctx.post('/v1/projects', {
            displayName: faker.animal.fish(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })

        expect(second.statusCode).toBe(StatusCodes.PAYMENT_REQUIRED)
        const body = second.json<{ code: string, params: { metric: string } }>()
        expect(body.code).toBe('QUOTA_EXCEEDED')
        expect(body.params.metric).toBe(PlatformUsageMetric.TEAM_PROJECTS)
    })

    it('rejects creating any TEAM project when the platform plan sets teamProjectsLimit to NONE', async () => {
        const ctx = await createTestContext(app!, { project: { type: ProjectType.PERSONAL } })
        teamProjectsLimitOverrides.set(ctx.platform.id, TeamProjectsLimit.NONE)

        const response = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })

        expect(response.statusCode).toBe(StatusCodes.PAYMENT_REQUIRED)
        const body = response.json<{ code: string, params: { metric: string } }>()
        expect(body.code).toBe('QUOTA_EXCEEDED')
    })

    it('does not apply the team-projects cap to PERSONAL project creation', async () => {
        const ctx = await createTestContext(app!)
        teamProjectsLimitOverrides.set(ctx.platform.id, TeamProjectsLimit.NONE)

        const personalProject = await projectService(system.globalLogger()).create({
            displayName: faker.animal.bird(),
            ownerId: ctx.user.id,
            platformId: ctx.platform.id,
            type: ProjectType.PERSONAL,
        })

        expect(personalProject.type).toBe(ProjectType.PERSONAL)
        expect(personalProject.platformId).toBe(ctx.platform.id)
    })

    it('allows unlimited TEAM projects when teamProjectsLimit is UNLIMITED (default CE plan)', async () => {
        const ctx = await createTestContext(app!)

        const first = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        const second = await ctx.post('/v1/projects', {
            displayName: faker.animal.fish(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })

        expect(first.statusCode).toBe(StatusCodes.CREATED)
        expect(second.statusCode).toBe(StatusCodes.CREATED)
    })
})

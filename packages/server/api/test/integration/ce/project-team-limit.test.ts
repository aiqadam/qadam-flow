import { PlatformUsageMetric, ProjectType } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { system } from '../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../src/app/helper/system/system-props'
import { projectService } from '../../../src/app/project/project-service'
import { createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

let app: FastifyInstance
let maxTeamProjectsOverride: string | undefined

describe('Project team-projects cap (CE, edition-neutral system prop)', () => {
    beforeAll(async () => {
        app = await setupTestEnvironment({ fresh: true })
        const original = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.MAX_TEAM_PROJECTS_PER_PLATFORM) {
                if (maxTeamProjectsOverride === undefined) {
                    return original(prop)
                }
                // Mirror system.getNumber's own contract: unparseable input becomes `null`,
                // not `NaN`, so this test exercises the real "malformed value" code path.
                const parsed = Number.parseInt(maxTeamProjectsOverride, 10)
                return Number.isNaN(parsed) ? null : parsed
            }
            return original(prop)
        })
    })

    afterEach(() => {
        maxTeamProjectsOverride = undefined
    })

    afterAll(async () => {
        vi.restoreAllMocks()
        await teardownTestEnvironment()
    })

    const createTeamProject = (ctx: Awaited<ReturnType<typeof createTestContext>>) => ctx.post('/v1/projects', {
        displayName: faker.animal.bird(),
        externalId: null,
        metadata: null,
        maxConcurrentJobs: null,
    })

    // createTestContext seeds a TEAM project by default (test/helpers/mocks/index.ts), which
    // would itself count toward the cap and make every test below off-by-one. Override it to
    // PERSONAL so the TEAM-project count starts at zero and each test's math is self-contained.
    const createContextWithoutSeedTeamProject = () => createTestContext(app, { project: { type: ProjectType.PERSONAL } })

    it('allows unlimited TEAM project creation when the cap is unset (default, zero behaviour change)', async () => {
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        const second = await createTeamProject(ctx)
        const third = await createTeamProject(ctx)

        expect(first.statusCode).toBe(StatusCodes.CREATED)
        expect(second.statusCode).toBe(StatusCodes.CREATED)
        expect(third.statusCode).toBe(StatusCodes.CREATED)
    })

    it('rejects the (N+1)th TEAM project once AP_MAX_TEAM_PROJECTS_PER_PLATFORM is reached, with QUOTA_EXCEEDED/403', async () => {
        maxTeamProjectsOverride = '1'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        expect(first.statusCode).toBe(StatusCodes.CREATED)

        const second = await createTeamProject(ctx)
        expect(second.statusCode).toBe(StatusCodes.FORBIDDEN)
        const body = second.json<{ code: string, params: { metric: string } }>()
        expect(body.code).toBe('QUOTA_EXCEEDED')
        expect(body.params.metric).toBe(PlatformUsageMetric.TEAM_PROJECTS)
    })

    it('does not count a soft-deleted TEAM project toward the cap', async () => {
        maxTeamProjectsOverride = '1'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        expect(first.statusCode).toBe(StatusCodes.CREATED)
        const firstProjectId = first.json<{ id: string }>().id

        const deleteResponse = await ctx.delete(`/v1/projects/${firstProjectId}`)
        expect(deleteResponse.statusCode).toBe(StatusCodes.NO_CONTENT)

        const second = await createTeamProject(ctx)
        expect(second.statusCode).toBe(StatusCodes.CREATED)
    })

    it('does not apply the TEAM-projects cap to PERSONAL project creation', async () => {
        // "0" means "block every TEAM project" (see getMaxTeamProjectsPerPlatform), a much
        // stricter cap than any test above. Creating a PERSONAL project through the same
        // projectService.create() codepath must still succeed, proving the cap check only runs
        // for ProjectType.TEAM and never blocks the onboarding flow that auto-creates a
        // PERSONAL project per user.
        maxTeamProjectsOverride = '0'
        const ctx = await createContextWithoutSeedTeamProject()

        const personalProject = await projectService(app.log).create({
            displayName: faker.animal.bird(),
            ownerId: ctx.user.id,
            platformId: ctx.platform.id,
            type: ProjectType.PERSONAL,
        })

        expect(personalProject.type).toBe(ProjectType.PERSONAL)
        expect(personalProject.platformId).toBe(ctx.platform.id)
    })

    it('malformed cap config (non-numeric) fails open to unlimited, not to zero', async () => {
        maxTeamProjectsOverride = 'not-a-number'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        const second = await createTeamProject(ctx)

        expect(first.statusCode).toBe(StatusCodes.CREATED)
        expect(second.statusCode).toBe(StatusCodes.CREATED)
    })
})

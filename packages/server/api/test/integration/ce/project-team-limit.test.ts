import { ProjectType } from '@aiqadam/shared'
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
                // not `NaN`. `system-validator.ts`'s numberValidator entry for this prop only
                // surfaces a *warning* at startup (validateSystemPropTypes logs, it never
                // throws — same as every other numberValidator-backed prop, e.g.
                // MAX_RECORDS_PER_TABLE), so a malformed value can still reach this function at
                // runtime; it must not be treated any differently than "unset".
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

    it('rejects the (N+1)th TEAM project once AP_MAX_TEAM_PROJECTS_PER_PLATFORM is reached, with RESOURCE_LIMIT_EXCEEDED/403', async () => {
        maxTeamProjectsOverride = '1'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        expect(first.statusCode).toBe(StatusCodes.CREATED)

        const second = await createTeamProject(ctx)
        expect(second.statusCode).toBe(StatusCodes.FORBIDDEN)
        const body = second.json<{ code: string, params: { resource: string, limit: number } }>()
        expect(body.code).toBe('RESOURCE_LIMIT_EXCEEDED')
        expect(body.params.resource).toBe('team_projects')
        expect(body.params.limit).toBe(1)
    })

    it('does not count a soft-deleted TEAM project toward the cap, and the cap still applies afterwards', async () => {
        maxTeamProjectsOverride = '1'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        expect(first.statusCode).toBe(StatusCodes.CREATED)
        const firstProjectId = first.json<{ id: string }>().id

        const deleteResponse = await ctx.delete(`/v1/projects/${firstProjectId}`)
        expect(deleteResponse.statusCode).toBe(StatusCodes.NO_CONTENT)

        // The soft-deleted project freed a "slot" back up to the cap of 1.
        const second = await createTeamProject(ctx)
        expect(second.statusCode).toBe(StatusCodes.CREATED)

        // But the cap itself is still live — a third TEAM project (the second live one) is
        // rejected. Without this assertion the test would also pass on `main`, where no cap
        // exists and every create returns 201 regardless of soft-deletes.
        const third = await createTeamProject(ctx)
        expect(third.statusCode).toBe(StatusCodes.FORBIDDEN)
    })

    it('does not apply the TEAM-projects cap to PERSONAL project creation', async () => {
        // Cap = 1: consume the one TEAM slot first, so a further TEAM create is provably rejected
        // under this config. (An earlier draft of this test used "0" here on the mistaken belief
        // that "0" means "block every TEAM project" — it does not: getMaxTeamProjectsPerPlatform
        // treats any non-positive value as "no cap" by design, so "0" is unlimited. See the
        // dedicated "0 configured value" test below for that exact case.)
        maxTeamProjectsOverride = '1'
        const ctx = await createContextWithoutSeedTeamProject()

        const consumesTheSlot = await createTeamProject(ctx)
        expect(consumesTheSlot.statusCode).toBe(StatusCodes.CREATED)

        // Prove the cap is actually live under this config: a second TEAM project is rejected.
        // Without this assertion the test would also pass on `main`, where no cap exists and
        // every create returns 201 regardless of project type.
        const teamAttempt = await createTeamProject(ctx)
        expect(teamAttempt.statusCode).toBe(StatusCodes.FORBIDDEN)

        // A PERSONAL project, created through the same projectService.create() codepath, must
        // still succeed — proving the cap check only runs for ProjectType.TEAM and never blocks
        // the onboarding flow that auto-creates a PERSONAL project per user.
        const personalProject = await projectService(app.log).create({
            displayName: faker.animal.bird(),
            ownerId: ctx.user.id,
            platformId: ctx.platform.id,
            type: ProjectType.PERSONAL,
        })

        expect(personalProject.type).toBe(ProjectType.PERSONAL)
        expect(personalProject.platformId).toBe(ctx.platform.id)
    })

    it('treats a configured value of "0" as unlimited, not as "block every TEAM project"', async () => {
        // Pins getMaxTeamProjectsPerPlatform's `configuredValue <= 0` branch: an operator who
        // sets AP_MAX_TEAM_PROJECTS_PER_PLATFORM=0 intending "no team projects at all" instead
        // gets no cap. This was previously asserted backwards in this file (see the review that
        // caught it) — this test exists specifically so that regression can't recur silently.
        maxTeamProjectsOverride = '0'
        const ctx = await createContextWithoutSeedTeamProject()

        const first = await createTeamProject(ctx)
        const second = await createTeamProject(ctx)

        expect(first.statusCode).toBe(StatusCodes.CREATED)
        expect(second.statusCode).toBe(StatusCodes.CREATED)
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

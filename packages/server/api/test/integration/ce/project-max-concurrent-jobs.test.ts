import { DefaultProjectRole, PlatformRole, PrincipalType, ProjectWithLimits } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { distributedStore } from '../../../src/app/database/redis-connections'
import { generateMockToken } from '../../helpers/auth'
import { mockBasicUser } from '../../helpers/mocks'
import { createMemberContext, createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

/**
 * `maxConcurrentJobs` is enforced by the rate limiter (rate-limiter-interceptor.ts, #201) —
 * a security review on the enforcement PR (#206) flagged that it went from a dead column to
 * a privilege-escalation vector at the same time: `POST /v1/projects` is open to every
 * authenticated USER, and the update route's only gate (callerCanAdministerProject) accepts
 * the project owner or a project ADMIN member — neither is a platform admin/operator. These
 * tests cover the fix (project-service.ts's assertCallerMayWriteMaxConcurrentJobs) and the
 * schema tightening that closes the "0 permanently blocks every dispatch" gap alongside it.
 */
describe('maxConcurrentJobs authorization and validation (CE)', () => {
    describe('POST /v1/projects (create)', () => {
        it('rejects a non-nil maxConcurrentJobs from a non-privileged (MEMBER) caller', async () => {
            const ctx = await createTestContext(app!)
            const { mockUser: member } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
            })
            const memberToken = await generateMockToken({
                id: member.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/projects',
                headers: { authorization: `Bearer ${memberToken}` },
                payload: { displayName: faker.animal.bird(), externalId: null, metadata: null, maxConcurrentJobs: 5 },
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response.json<{ code: string }>().code).toBe('AUTHORIZATION')
        })

        it('allows a privileged (ADMIN) caller to set maxConcurrentJobs, and it round-trips in the response', async () => {
            // createTestContext's owner is always PlatformRole.ADMIN (mockAndSaveBasicSetup
            // hardcodes it), so the default ctx is already a privileged caller.
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: 5,
            })

            expect(response.statusCode).toBe(StatusCodes.CREATED)
            expect(response.json<ProjectWithLimits>().maxConcurrentJobs).toBe(5)
        })

        it('still allows a non-privileged caller to send an explicit null (no-op, existing clients keep working)', async () => {
            const ctx = await createTestContext(app!)
            const { mockUser: member } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
            })
            const memberToken = await generateMockToken({
                id: member.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/projects',
                headers: { authorization: `Bearer ${memberToken}` },
                payload: { displayName: faker.animal.bird(), externalId: null, metadata: null, maxConcurrentJobs: null },
            })

            expect(response.statusCode).toBe(StatusCodes.CREATED)
        })

        it('rejects a non-positive maxConcurrentJobs at the schema level, even from a privileged caller', async () => {
            const ctx = await createTestContext(app!)

            const zero = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: 0,
            })
            expect(zero.statusCode).toBe(StatusCodes.BAD_REQUEST)

            const negative = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: -1,
            })
            expect(negative.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('rejects a maxConcurrentJobs above the Postgres integer column bound at the schema level', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: 2147483648,
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describe('POST /v1/projects/:id (update)', () => {
        it('rejects a non-nil maxConcurrentJobs from the non-privileged project owner', async () => {
            const ctx = await createTestContext(app!)
            const { mockUser: member } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
            })
            const memberToken = await generateMockToken({
                id: member.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })

            // The MEMBER creates their own project (no maxConcurrentJobs) — as the owner,
            // callerCanAdministerProject lets them update it, but they are still not
            // platform-privileged.
            const createResponse = await app!.inject({
                method: 'POST',
                url: '/api/v1/projects',
                headers: { authorization: `Bearer ${memberToken}` },
                payload: { displayName: faker.animal.bird(), externalId: null, metadata: null, maxConcurrentJobs: null },
            })
            expect(createResponse.statusCode).toBe(StatusCodes.CREATED)
            const ownProject = createResponse.json<ProjectWithLimits>()

            const updateResponse = await app!.inject({
                method: 'POST',
                url: `/api/v1/projects/${ownProject.id}`,
                headers: { authorization: `Bearer ${memberToken}` },
                payload: { maxConcurrentJobs: 5 },
            })

            expect(updateResponse.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(updateResponse.json<{ code: string }>().code).toBe('AUTHORIZATION')
        })

        it('allows a privileged (ADMIN) caller to set maxConcurrentJobs on update, and it round-trips', async () => {
            const ctx = await createTestContext(app!)
            const createResponse = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })
            const created = createResponse.json<ProjectWithLimits>()

            const updateResponse = await ctx.post(`/v1/projects/${created.id}`, { maxConcurrentJobs: 5 })

            expect(updateResponse.statusCode).toBe(StatusCodes.OK)
            expect(updateResponse.json<ProjectWithLimits>().maxConcurrentJobs).toBe(5)
        })

        it('rejects a non-positive maxConcurrentJobs at the schema level on update', async () => {
            const ctx = await createTestContext(app!)
            const createResponse = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })
            const created = createResponse.json<ProjectWithLimits>()

            const response = await ctx.post(`/v1/projects/${created.id}`, { maxConcurrentJobs: 0 })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('rejects a maxConcurrentJobs above the Postgres integer column bound at the schema level', async () => {
            const ctx = await createTestContext(app!)
            const createResponse = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })
            const created = createResponse.json<ProjectWithLimits>()

            const response = await ctx.post(`/v1/projects/${created.id}`, { maxConcurrentJobs: 2147483648 })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    // A prior revision gated on "is the field non-nil" rather than "does the value change",
    // which had two failure modes fixed here: a non-privileged caller could still *clear* an
    // operator-set cap (isNil(null) is true, same escalation the other way), and — the one that
    // would have hit real users — the web client always sends `maxConcurrentJobs` on every
    // project update (project-collection.ts's onUpdate includes it unconditionally, seeded from
    // the current value by a form whose input only renders for platform admins), so a
    // MEMBER-role project admin saving an unrelated field (display name, releases toggle, pieces
    // filter) on a project that already had a cap would get a 403 with no way to save anything.
    describe('change-based gate (only an actual change to maxConcurrentJobs requires privilege)', () => {
        it('rejects a non-privileged caller nulling out an operator-set cap', async () => {
            const ctx = await createTestContext(app!)
            const setCapResponse = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 2 })
            expect(setCapResponse.statusCode).toBe(StatusCodes.OK)

            // Project-ADMIN-role member, not platform-privileged — administers the project
            // (callerCanAdministerProject) but isPrivileged is still false.
            const memberCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

            const clearResponse = await memberCtx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: null })

            expect(clearResponse.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(clearResponse.json<{ code: string }>().code).toBe('AUTHORIZATION')
        })

        it('allows a non-privileged caller to echo the current maxConcurrentJobs value while updating an unrelated field', async () => {
            const ctx = await createTestContext(app!)
            const setCapResponse = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 2 })
            expect(setCapResponse.statusCode).toBe(StatusCodes.OK)

            const memberCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })
            const newDisplayName = faker.animal.bird()

            const response = await memberCtx.post(`/v1/projects/${ctx.project.id}`, {
                displayName: newDisplayName,
                maxConcurrentJobs: 2,
            })

            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json<ProjectWithLimits>()
            expect(body.displayName).toBe(newDisplayName)
            expect(body.maxConcurrentJobs).toBe(2)
        })

        it('allows a privileged caller to clear an existing cap to null', async () => {
            const ctx = await createTestContext(app!)
            const setCapResponse = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 2 })
            expect(setCapResponse.statusCode).toBe(StatusCodes.OK)

            const clearResponse = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: null })

            expect(clearResponse.statusCode).toBe(StatusCodes.OK)
            expect(clearResponse.json<ProjectWithLimits>().maxConcurrentJobs).toBeNull()
        })
    })

    // A non-privileged caller can only ever reach the write by echoing the value it read, so
    // writing the column for it would be a no-op — except that the row can change between the
    // read at the top of `update` and the write, turning the no-op into a revert of an
    // operator's concurrent change. `update` therefore skips the column write, and this
    // invalidation, unless the caller is privileged.
    //
    // Honest limit: this pins the invalidation half, which is deterministically observable. The
    // write-skip itself would need the read-to-write window forced open from inside the service
    // to test directly, which there is no hook for — so it rests on the code reading plainly,
    // not on a test.
    describe('read-to-write window', () => {
        it('does not invalidate the cache for a non-privileged echo of the current value', async () => {
            const ctx = await createTestContext(app!)
            const setCapResponse = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 4 })
            expect(setCapResponse.statusCode).toBe(StatusCodes.OK)

            const memberCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })
            const deleteSpy = vi.spyOn(distributedStore, 'delete')

            try {
                const echoResponse = await memberCtx.post(`/v1/projects/${ctx.project.id}`, {
                    displayName: 'renamed by a project admin',
                    maxConcurrentJobs: 4,
                })

                expect(echoResponse.statusCode).toBe(StatusCodes.OK)
                expect(echoResponse.json<ProjectWithLimits>().maxConcurrentJobs).toBe(4)
                expect(deleteSpy).not.toHaveBeenCalled()
            }
            finally {
                deleteSpy.mockRestore()
            }
        })

        it('does invalidate the cache when a privileged caller changes the value', async () => {
            const ctx = await createTestContext(app!)
            const deleteSpy = vi.spyOn(distributedStore, 'delete')

            try {
                const response = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 6 })

                expect(response.statusCode).toBe(StatusCodes.OK)
                expect(deleteSpy).toHaveBeenCalledWith(expect.stringContaining(ctx.project.id))
            }
            finally {
                deleteSpy.mockRestore()
            }
        })
    })

    // The cache-invalidation delete (project-service.ts's update) runs after the row has already
    // committed in Postgres — a raw ioredis error there must not turn a landed update into a
    // 500, since a client that then rolls back its optimistic UI to the pre-update value would
    // be rolling back to a value the server no longer has.
    describe('cache invalidation resilience', () => {
        it('does not fail the update when invalidating the maxConcurrentJobs cache entry throws', async () => {
            const ctx = await createTestContext(app!)
            const deleteSpy = vi.spyOn(distributedStore, 'delete').mockRejectedValueOnce(new Error('simulated redis blip'))

            try {
                const response = await ctx.post(`/v1/projects/${ctx.project.id}`, { maxConcurrentJobs: 5 })

                expect(response.statusCode).toBe(StatusCodes.OK)
                expect(response.json<ProjectWithLimits>().maxConcurrentJobs).toBe(5)
            }
            finally {
                deleteSpy.mockRestore()
            }
        })
    })
})

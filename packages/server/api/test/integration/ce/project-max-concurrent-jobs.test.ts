import { PlatformRole, PrincipalType, ProjectWithLimits } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../helpers/auth'
import { mockBasicUser } from '../../helpers/mocks'
import { createTestContext } from '../../helpers/test-context'
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
    })
})

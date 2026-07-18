import { ProjectType, ProjectWithLimits, SeekPage } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Project endpoints (CE)', () => {
    describe('POST /v1/projects', () => {
        it('creates a team project and returns 201 with ProjectWithLimits', async () => {
            const ctx = await createTestContext(app!)
            const displayName = faker.animal.bird()

            const response = await ctx.post('/v1/projects', {
                displayName,
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })

            expect(response.statusCode).toBe(StatusCodes.CREATED)
            const body = response.json<ProjectWithLimits>()
            expect(body.displayName).toBe(displayName)
            expect(body.type).toBe(ProjectType.TEAM)
            expect(body.ownerId).toBe(ctx.user.id)
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.plan).toBeDefined()
            expect(body.analytics).toBeDefined()
        })

        it('allows creating multiple team projects', async () => {
            const ctx = await createTestContext(app!)

            const first = await ctx.post('/v1/projects', { displayName: faker.animal.bird(), externalId: null, metadata: null, maxConcurrentJobs: null })
            const second = await ctx.post('/v1/projects', { displayName: faker.animal.fish(), externalId: null, metadata: null, maxConcurrentJobs: null })

            expect(first.statusCode).toBe(StatusCodes.CREATED)
            expect(second.statusCode).toBe(StatusCodes.CREATED)
        })

        it('returns 400 when displayName is missing', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/projects', {
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('returns 403 when unauthenticated', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/projects',
                payload: { displayName: 'Test', externalId: null, metadata: null, maxConcurrentJobs: null },
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })

    describe('GET /v1/projects', () => {
        it('lists projects for authenticated user', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.get('/v1/projects')

            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json<SeekPage<ProjectWithLimits>>()
            expect(Array.isArray(body.data)).toBe(true)
        })

        it('newly created team project appears in list', async () => {
            const ctx = await createTestContext(app!)
            const displayName = faker.animal.bird()

            await ctx.post('/v1/projects', { displayName, externalId: null, metadata: null, maxConcurrentJobs: null })

            const response = await ctx.get('/v1/projects')
            const body = response.json<SeekPage<ProjectWithLimits>>()
            const found = body.data.find((p) => p.displayName === displayName)
            expect(found).toBeDefined()
            expect(found?.type).toBe(ProjectType.TEAM)
        })
    })

    describe('DELETE /v1/projects/:id', () => {
        it('soft-deletes a team project and removes it from list', async () => {
            const ctx = await createTestContext(app!)

            const createResponse = await ctx.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })
            expect(createResponse.statusCode).toBe(StatusCodes.CREATED)
            const created = createResponse.json<ProjectWithLimits>()

            const deleteResponse = await ctx.delete(`/v1/projects/${created.id}`)
            expect(deleteResponse.statusCode).toBe(StatusCodes.NO_CONTENT)

            const listResponse = await ctx.get('/v1/projects')
            const body = listResponse.json<SeekPage<ProjectWithLimits>>()
            const found = body.data.find((p) => p.id === created.id)
            expect(found).toBeUndefined()
        })

        it('returns 404 when project does not exist', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.delete('/v1/projects/nonexistent-id')
            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('returns 404 when project belongs to a different platform (multi-tenant isolation)', async () => {
            const platformAOwner = await createTestContext(app!)
            const platformBOwner = await createTestContext(app!)

            const createResponse = await platformAOwner.post('/v1/projects', {
                displayName: faker.animal.bird(),
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            })
            expect(createResponse.statusCode).toBe(StatusCodes.CREATED)
            const platformAProject = createResponse.json<ProjectWithLimits>()

            const crossPlatformDeleteResponse = await platformBOwner.delete(`/v1/projects/${platformAProject.id}`)
            expect(crossPlatformDeleteResponse.statusCode).toBe(StatusCodes.NOT_FOUND)

            const listResponse = await platformAOwner.get('/v1/projects')
            const body = listResponse.json<SeekPage<ProjectWithLimits>>()
            const stillThere = body.data.find((p) => p.id === platformAProject.id)
            expect(stillThere).toBeDefined()
        })
    })
})

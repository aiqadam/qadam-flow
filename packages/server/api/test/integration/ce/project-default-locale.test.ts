import { ProjectWithLimits } from '@aiqadam/shared'
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

// project-service.ts's normalizeDefaultLocale canonicalizes on write so the engine's own
// resolution chain (which also canonicalizes every candidate) can compare against a stable
// stored form, and rejects a tag Intl.getCanonicalLocales cannot parse rather than storing it
// malformed.
describe('POST /v1/projects/:id — defaultLocale (CE)', () => {
    it('canonicalizes a valid BCP-47 tag on write', async () => {
        const ctx = await createTestContext(app!)
        const createResponse = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
        })
        const created = createResponse.json<ProjectWithLimits>()

        const response = await ctx.post(`/v1/projects/${created.id}`, { defaultLocale: 'ru-ru' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json<ProjectWithLimits>().defaultLocale).toBe('ru-RU')
    })

    it('rejects a tag that cannot be canonicalized', async () => {
        const ctx = await createTestContext(app!)
        const createResponse = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
        })
        const created = createResponse.json<ProjectWithLimits>()

        const response = await ctx.post(`/v1/projects/${created.id}`, { defaultLocale: 'not a locale tag!!' })

        expect(response.statusCode).toBe(StatusCodes.CONFLICT)
    })

    it('clears an existing defaultLocale when explicitly set to null', async () => {
        const ctx = await createTestContext(app!)
        const createResponse = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
        })
        const created = createResponse.json<ProjectWithLimits>()
        await ctx.post(`/v1/projects/${created.id}`, { defaultLocale: 'en' })

        const response = await ctx.post(`/v1/projects/${created.id}`, { defaultLocale: null })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json<ProjectWithLimits>().defaultLocale).toBeNull()
    })

    it('leaves defaultLocale untouched when the field is omitted from the update', async () => {
        const ctx = await createTestContext(app!)
        const createResponse = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
        })
        const created = createResponse.json<ProjectWithLimits>()
        await ctx.post(`/v1/projects/${created.id}`, { defaultLocale: 'kk' })

        const response = await ctx.post(`/v1/projects/${created.id}`, { displayName: faker.animal.bird() })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json<ProjectWithLimits>().defaultLocale).toBe('kk')
    })
})

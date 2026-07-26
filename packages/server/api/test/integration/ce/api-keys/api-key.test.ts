import { apId, ApiKeyResponseWithValue, PlatformRole, PrincipalType, ResponseApiKey, SeekPage } from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { MAX_API_KEYS_PER_PLATFORM } from '../../../../src/app/api-keys/api-key.service'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockBasicUser } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function createKey(ctx: Awaited<ReturnType<typeof createTestContext>>): Promise<ApiKeyResponseWithValue> {
    const res = await ctx.post('/v1/api-keys', { displayName: faker.lorem.word() })
    expect(res.statusCode).toBe(StatusCodes.CREATED)
    return res.json<ApiKeyResponseWithValue>()
}

describe('POST /v1/api-keys', () => {
    it('returns the full secret exactly once and never the hash', async () => {
        const ctx = await createTestContext(app!)

        const apiKey = await createKey(ctx)

        expect(apiKey.value.startsWith('sk-')).toBe(true)
        expect(apiKey.truncatedValue).toBe(apiKey.value.slice(-4))
        expect('hashedValue' in apiKey).toBe(false)
    })

    it('rejects a blank display name', async () => {
        const ctx = await createTestContext(app!)

        const res = await ctx.post('/v1/api-keys', { displayName: '' })

        expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects creation once the per-platform cap is reached', async () => {
        const ctx = await createTestContext(app!)

        const now = new Date().toISOString()
        const seededKeys = Array.from({ length: MAX_API_KEYS_PER_PLATFORM }, () => ({
            id: apId(),
            created: now,
            updated: now,
            displayName: faker.lorem.word(),
            platformId: ctx.platform.id,
            hashedValue: apId(),
            truncatedValue: 'abcd',
        }))
        await db.save('api_key', seededKeys)

        const res = await ctx.post('/v1/api-keys', { displayName: faker.lorem.word() })

        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
    })

    it('forbids non-admin platform members', async () => {
        const ctx = await createTestContext(app!)
        const { mockUser } = await mockBasicUser({
            user: {
                platformId: ctx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const memberToken = await generateMockToken({
            id: mockUser.id,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })

        const res = await app!.inject({
            method: 'POST',
            url: '/api/v1/api-keys',
            headers: { authorization: `Bearer ${memberToken}` },
            payload: { displayName: faker.lorem.word() },
        })

        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('GET /v1/api-keys', () => {
    it('lists keys without exposing the secret or hash', async () => {
        const ctx = await createTestContext(app!)
        const created = await createKey(ctx)

        const res = await ctx.get('/v1/api-keys')

        expect(res.statusCode).toBe(StatusCodes.OK)
        const page = res.json<SeekPage<ResponseApiKey>>()
        const listed = page.data.find((key) => key.id === created.id)
        expect(listed).toBeDefined()
        expect(listed?.truncatedValue).toBe(created.truncatedValue)
        expect('hashedValue' in listed!).toBe(false)
        expect('value' in listed!).toBe(false)
    })

    it('isolates keys per platform', async () => {
        const ctxA = await createTestContext(app!)
        const createdA = await createKey(ctxA)
        const ctxB = await createTestContext(app!)

        const res = await ctxB.get('/v1/api-keys')

        const page = res.json<SeekPage<ResponseApiKey>>()
        expect(page.data.some((key) => key.id === createdA.id)).toBe(false)
    })
})

describe('api key privilege', () => {
    it('does not let a SERVICE principal manage api keys', async () => {
        const ctx = await createTestContext(app!)
        const apiKey = await createKey(ctx)
        const serviceAuth = { authorization: `Bearer ${apiKey.value}` }

        const createRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/api-keys',
            headers: serviceAuth,
            payload: { displayName: faker.lorem.word() },
        })
        expect(createRes.statusCode).toBe(StatusCodes.FORBIDDEN)

        const listRes = await app!.inject({
            method: 'GET',
            url: '/api/v1/api-keys',
            headers: serviceAuth,
        })
        expect(listRes.statusCode).toBe(StatusCodes.FORBIDDEN)

        const deleteRes = await app!.inject({
            method: 'DELETE',
            url: `/api/v1/api-keys/${apiKey.id}`,
            headers: serviceAuth,
        })
        expect(deleteRes.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('api key authentication', () => {
    it('authenticates a project-scoped request with a valid key', async () => {
        const ctx = await createTestContext(app!)
        const apiKey = await createKey(ctx)

        const res = await app!.inject({
            method: 'GET',
            url: `/api/v1/tables?projectId=${ctx.project.id}`,
            headers: { authorization: `Bearer ${apiKey.value}` },
        })

        expect(res.statusCode).toBe(StatusCodes.OK)
    })

    it('rejects an unknown key', async () => {
        const res = await app!.inject({
            method: 'GET',
            url: '/api/v1/users',
            headers: { authorization: 'Bearer sk-does-not-exist' },
        })

        expect(res.statusCode).toBe(StatusCodes.UNAUTHORIZED)
    })

    it('stops authenticating once the key is deleted', async () => {
        const ctx = await createTestContext(app!)
        const apiKey = await createKey(ctx)

        const deleteRes = await ctx.delete(`/v1/api-keys/${apiKey.id}`)
        expect(deleteRes.statusCode).toBe(StatusCodes.NO_CONTENT)

        const res = await app!.inject({
            method: 'GET',
            url: `/api/v1/tables?projectId=${ctx.project.id}`,
            headers: { authorization: `Bearer ${apiKey.value}` },
        })

        expect(res.statusCode).toBe(StatusCodes.UNAUTHORIZED)
    })

    it('denies a key access to another platform\'s project', async () => {
        const ctxA = await createTestContext(app!)
        const apiKeyA = await createKey(ctxA)
        const ctxB = await createTestContext(app!)

        const res = await app!.inject({
            method: 'GET',
            url: `/api/v1/tables?projectId=${ctxB.project.id}`,
            headers: { authorization: `Bearer ${apiKeyA.value}` },
        })

        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})

describe('DELETE /v1/api-keys/:id', () => {
    it('does not delete a key belonging to another platform', async () => {
        const ctxA = await createTestContext(app!)
        const createdA = await createKey(ctxA)
        const ctxB = await createTestContext(app!)

        const res = await ctxB.delete(`/v1/api-keys/${createdA.id}`)
        expect(res.statusCode).toBe(StatusCodes.NO_CONTENT)

        const listA = (await ctxA.get('/v1/api-keys')).json<SeekPage<ResponseApiKey>>()
        expect(listA.data.some((key) => key.id === createdA.id)).toBe(true)
    })
})

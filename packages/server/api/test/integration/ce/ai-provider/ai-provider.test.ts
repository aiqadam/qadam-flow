import { AIProviderName, apId, ErrorCode, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

describe('AI Providers API', () => {
    describe('POST /v1/ai-providers (create)', () => {
        it('should create a custom provider with defaultHeaders', async () => {
            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'My Custom Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: {
                        'X-Organization-Id': 'org-123',
                        'X-Tenant': 'tenant-abc',
                    },
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneBy('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
            })
            expect((saved as any).config.defaultHeaders).toEqual({
                'X-Organization-Id': 'org-123',
                'X-Tenant': 'tenant-abc',
            })
        })

        it('should reject a second provider of the same type with a conflict, not a database error', async () => {
            const body = {
                provider: AIProviderName.CUSTOM,
                displayName: 'DeepSeek',
                config: {
                    baseUrl: 'https://api.deepseek.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                auth: { apiKey: 'test-key' },
            }

            const first = await ctx.post('/v1/ai-providers', body)
            expect(first?.statusCode).toBe(StatusCodes.OK)

            const second = await ctx.post('/v1/ai-providers', {
                ...body,
                displayName: 'Local Ollama',
                config: { ...body.config, baseUrl: 'http://ollama.internal:11434/v1' },
            })

            expect(second?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(second?.json().code).toBe(ErrorCode.EXISTING_AI_PROVIDER)
            // The dialog renders params.message, so it has to say something a user can act on.
            expect(second?.json().params.message).toContain('already configured')
            // The Postgres error code and the index name used to reach the caller verbatim.
            expect(second?.body).not.toContain('23505')
            expect(second?.body).not.toContain('idx_ai_provider')
        })

        it('should persist enabledForChat and clear it on the previous chat provider', async () => {
            const previousChatProvider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.OPENAI,
                displayName: 'Previous chat provider',
            })
            await db.update('ai_provider', previousChatProvider.id, { enabledForChat: true })

            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'New chat provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                auth: { apiKey: 'test-key' },
                enabledForChat: true,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const created = await db.findOneByOrFail('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
            })
            expect((created as any).enabledForChat).toBe(true)

            const previous = await db.findOneByOrFail('ai_provider', { id: previousChatProvider.id })
            expect((previous as any).enabledForChat).toBe(false)
        })

        it('should default enabledForChat to false when it is not sent', async () => {
            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'Not a chat provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneByOrFail('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
            })
            expect((saved as any).enabledForChat).toBe(false)
        })
    })

    describe('POST /v1/ai-providers/:id (update)', () => {
        it('should update defaultHeaders on an existing provider', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Existing Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                displayName: 'Existing Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Custom': 'value-1' },
                },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneBy('ai_provider', { id: provider.id })
            expect((saved as any).config.defaultHeaders).toEqual({ 'X-Custom': 'value-1' })
        })

        it('should keep the display name when the update does not carry one', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Name worth keeping',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                config: {
                    baseUrl: 'https://api.example.com/v2',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).displayName).toBe('Name worth keeping')
            expect((saved as any).config.baseUrl).toBe('https://api.example.com/v2')
        })

        it('should leave the row alone when the update carries no fields', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Untouched',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {})

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).displayName).toBe('Untouched')
            expect((saved as any).config.baseUrl).toBe('https://api.example.com/v1')
        })

        it('should move the updated timestamp, which is what expires the cached model list', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Cache key source',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })
            const before = await db.findOneByOrFail('ai_provider', { id: provider.id })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                auth: { apiKey: 'rotated-key' },
            })
            expect(response?.statusCode).toBe(StatusCodes.OK)

            const after = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect(new Date((after as any).updated).getTime())
                .toBeGreaterThan(new Date((before as any).updated).getTime())
        })
    })

    describe('GET /v1/ai-providers/:provider/config', () => {
        it('should return config with defaultHeaders and platformId', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Config Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Org': 'org-789' },
                },
            })

            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: ctx.project.id,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${engineToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
           
            expect(body.provider).toBe(AIProviderName.CUSTOM)
            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.config.defaultHeaders).toEqual({ 'X-Org': 'org-789' })
        })

        it('should return platformId even without custom headers config', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Minimal Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: ctx.project.id,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${engineToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.config.defaultHeaders).toBeUndefined()
        })
    })

    describe('GET /v1/ai-providers (list)', () => {
        it('should include config with defaultHeaders when listing providers', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Listed Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                    defaultHeaders: { 'X-Test': 'test' },
                },
            })

            const response = await ctx.get('/v1/ai-providers')

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            const customProvider = body.find(
                (p: any) => p.provider === AIProviderName.CUSTOM,
            )
            expect(customProvider).toBeDefined()
            expect(customProvider.config.defaultHeaders).toEqual({ 'X-Test': 'test' })
        })
    })
})

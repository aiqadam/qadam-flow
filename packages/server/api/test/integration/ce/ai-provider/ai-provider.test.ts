import { AIProviderModelType, AIProviderName, apId, DefaultProjectRole, ErrorCode, isNil, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { AIProviderSchema } from '../../../../src/app/ai/ai-provider-entity'
import { CUSTOM_PROVIDER_LIMIT_MESSAGE } from '../../../../src/app/ai/ai-provider-service'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockAndSaveAIProvider } from '../../../helpers/mocks'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

// The override is set as a real environment variable rather than by stubbing `system.getNumber`.
// A stub has to reimplement that method's parse, and an earlier revision of this file did — which
// meant the tests asserted against a copy of the contract instead of the contract, with nothing
// keeping the two in sync. `environmentVariables.getEnvironment` reads `process.env` on every
// call, so setting it here exercises the real path end to end.
const MAX_CUSTOM_PROVIDERS_ENV_VAR = `AP_${AppSystemProp.MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM}`
const originalMaxCustomProviders = process.env[MAX_CUSTOM_PROVIDERS_ENV_VAR]

const setMaxCustomProvidersOverride = (value: string | undefined) => {
    if (isNil(value)) {
        delete process.env[MAX_CUSTOM_PROVIDERS_ENV_VAR]
        return
    }
    process.env[MAX_CUSTOM_PROVIDERS_ENV_VAR] = value
}

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

afterEach(() => {
    setMaxCustomProvidersOverride(originalMaxCustomProviders)
})

const customProviderBody = (overrides?: Record<string, unknown>) => ({
    provider: AIProviderName.CUSTOM,
    displayName: 'A custom provider',
    config: {
        baseUrl: 'https://api.example.com/v1',
        apiKeyHeader: 'Authorization',
        models: [],
    },
    auth: { apiKey: 'test-key' },
    ...overrides,
})

const modelList = (count: number) => Array.from({ length: count }, (_, index) => ({
    modelId: `model-${index}`,
    modelName: `Model ${index}`,
    modelType: AIProviderModelType.TEXT,
}))

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

        it('should allow a second custom provider, each addressable by its own id', async () => {
            const deepseek = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'DeepSeek',
                config: { baseUrl: 'https://api.deepseek.com/v1', apiKeyHeader: 'Authorization', models: [] },
                auth: { apiKey: 'test-key' },
            })
            const ollama = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CUSTOM,
                displayName: 'Local Ollama',
                config: { baseUrl: 'http://ollama.internal:11434/v1', apiKeyHeader: 'Authorization', models: [] },
                auth: { apiKey: 'test-key' },
            })

            // This is the assertion issue #98 exists for.
            expect(deepseek?.statusCode).toBe(StatusCodes.OK)
            expect(ollama?.statusCode).toBe(StatusCodes.OK)

            const rows = await db.find('ai_provider', { platformId: ctx.platform.id, provider: AIProviderName.CUSTOM })
            expect(rows).toHaveLength(2)
            expect(new Set(rows.map((r: any) => r.id)).size).toBe(2)
        })

        it('should still reject a second provider of a singleton type with a conflict, not a database error', async () => {
            // CLOUDFLARE_GATEWAY, not CUSTOM: custom is legitimately duplicable now, and it is the
            // only other provider whose validateConnection makes no network call with `models: []`.
            const body = {
                provider: AIProviderName.CLOUDFLARE_GATEWAY,
                displayName: 'Gateway',
                config: { accountId: 'acc', gatewayId: 'gw', models: [] },
                auth: { apiKey: 'test-key' },
            }

            const first = await ctx.post('/v1/ai-providers', body)
            expect(first?.statusCode).toBe(StatusCodes.OK)

            const second = await ctx.post('/v1/ai-providers', { ...body, displayName: 'Gateway again' })

            expect(second?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(second?.json().code).toBe(ErrorCode.EXISTING_AI_PROVIDER)
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

        it('should default enabledForChat to false and leave an existing chat provider alone', async () => {
            const existingChatProvider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.OPENAI,
                displayName: 'Still the chat provider',
            })
            await db.update('ai_provider', existingChatProvider.id, { enabledForChat: true })

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

            // Without this half the test cannot tell "defaulted to false" from "silently dropped".
            const untouched = await db.findOneByOrFail('ai_provider', { id: existingChatProvider.id })
            expect((untouched as any).enabledForChat).toBe(true)
        })

        it('should not disable the existing chat provider when the create is rejected as a duplicate', async () => {
            const body = {
                provider: AIProviderName.CLOUDFLARE_GATEWAY,
                displayName: 'The one chat provider',
                config: { accountId: 'acc', gatewayId: 'gw', models: [] },
                auth: { apiKey: 'test-key' },
                enabledForChat: true,
            }

            const first = await ctx.post('/v1/ai-providers', body)
            expect(first?.statusCode).toBe(StatusCodes.OK)

            const second = await ctx.post('/v1/ai-providers', { ...body, displayName: 'Rejected' })
            expect(second?.statusCode).toBe(StatusCodes.CONFLICT)

            // The clearing sweep runs before the insert, so a rejected create must roll it back —
            // otherwise a 409 silently leaves the platform with no chat provider at all.
            const saved = await db.findOneByOrFail('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CLOUDFLARE_GATEWAY,
            })
            expect((saved as any).displayName).toBe('The one chat provider')
            expect((saved as any).enabledForChat).toBe(true)
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

        it('should reject an update that carries no field this endpoint understands', async () => {
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

            // Every field is optional now, so zod strips a misspelled key and leaves an empty
            // body. Answering 200 to that would report a rename that never happened.
            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, { display_name: 'renamed' })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response?.json().code).toBe(ErrorCode.VALIDATION)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).displayName).toBe('Untouched')
        })

        it('should reject a config that does not fit the row\'s provider instead of blanking it', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Keeps its config',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{ modelId: 'm', modelName: 'M', modelType: AIProviderModelType.TEXT }],
                },
            })

            // `AIProviderConfig` is an untagged union ending in `z.object({})`, so a custom config
            // missing `models` parses to `{}` and every field is dropped — silently wiping the
            // base url, the header name and the model catalogue of a live provider.
            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                config: {
                    baseUrl: 'https://api.example.com/v2',
                    apiKeyHeader: 'Authorization',
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response?.json().code).toBe(ErrorCode.VALIDATION)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).config.baseUrl).toBe('https://api.example.com/v1')
            expect((saved as any).config.models).toHaveLength(1)
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

    describe('GET /v1/ai-providers/:providerRef/config', () => {
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

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${await mockEngineToken()}` },
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

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${await mockEngineToken()}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body.platformId).toBe(ctx.platform.id)
            expect(body.config.defaultHeaders).toBeUndefined()
        })

        it('should resolve a provider name to the oldest matching row', async () => {
            // Seeded newest-first on purpose. An unordered read of a table this small is a
            // sequential scan returning insertion order, so seeding in `created` order would let
            // this pass with no ORDER BY at all — measured: that version stayed green with the
            // clause deleted. Reversing the two makes the ordering the only thing under test.
            const newest = await mockAndSaveCustomProvider({
                platformId: ctx.platform.id,
                displayName: 'Added afterwards',
                created: '2025-06-01T00:00:00.000Z',
                baseUrl: 'https://newest.example.com/v1',
            })
            const oldest = await mockAndSaveCustomProvider({
                platformId: ctx.platform.id,
                displayName: 'Configured before the upgrade',
                created: '2024-01-01T00:00:00.000Z',
                baseUrl: 'https://oldest.example.com/v1',
            })

            // `createMockAIProvider` defaults `created` to `faker.date.recent()`, so the explicit
            // timestamps are the whole basis of this assertion — check they reached the rows rather
            // than assume it, or the test is a coin flip that passes either way.
            const storedOldest = await db.findOneByOrFail<any>('ai_provider', { id: oldest.id })
            const storedNewest = await db.findOneByOrFail<any>('ai_provider', { id: newest.id })
            expect(new Date(storedOldest.created).getTime())
                .toBeLessThan(new Date(storedNewest.created).getTime())

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${AIProviderName.CUSTOM}/config`,
                headers: { authorization: `Bearer ${await mockEngineToken()}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            // Pinned qadam versions send the name and must keep reaching the row that existed when
            // they were published, not whichever row Postgres returns first.
            expect(response?.json().id).toBe(oldest.id)
            expect(response?.json().config.baseUrl).toBe('https://oldest.example.com/v1')
        })

        it('should address a provider by its own id instead of resolving the name', async () => {
            await mockAndSaveCustomProvider({
                platformId: ctx.platform.id,
                displayName: 'The row the name path would win',
                created: '2024-01-01T00:00:00.000Z',
                baseUrl: 'https://oldest.example.com/v1',
            })
            // Deliberately the newer row: the name path resolves to the oldest, so an id lookup
            // that degraded into a name lookup would answer 200 with the wrong provider's
            // credentials — which no assertion on status or on id-distinctness can catch.
            const target = await mockAndSaveCustomProvider({
                platformId: ctx.platform.id,
                displayName: 'Addressed by id',
                created: '2025-06-01T00:00:00.000Z',
                baseUrl: 'https://target.example.com/v1',
            })

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/ai-providers/${target.id}/config`,
                headers: { authorization: `Bearer ${await mockEngineToken()}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().id).toBe(target.id)
            expect(response?.json().config.baseUrl).toBe('https://target.example.com/v1')
        })
    })

    describe('GET /v1/ai-providers (list)', () => {
        it('should include config with defaultHeaders when a platform admin lists providers', async () => {
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

        // #297: `defaultHeaders` is an operator-defined record that commonly carries a second
        // bearer/signing header, so it must not reach a caller who is neither the engine nor a
        // platform admin. `baseUrl` and `apiKeyHeader` are not secret values and the model picker
        // (`provider-options.ts`) reads `baseUrl` off this exact response to disambiguate two rows
        // of the same provider type, so those stay.
        it('should redact defaultHeaders when a non-admin platform member lists providers', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Listed Provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{ modelId: 'm', modelName: 'M', modelType: AIProviderModelType.TEXT }],
                    defaultHeaders: { 'X-Test': 'test' },
                },
            })
            const member = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

            const response = await member.get('/v1/ai-providers')

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            const customProvider = body.find(
                (p: any) => p.provider === AIProviderName.CUSTOM,
            )
            expect(customProvider).toBeDefined()
            expect(customProvider.config.defaultHeaders).toBeUndefined()
            expect(customProvider.config.baseUrl).toBe('https://api.example.com/v1')
            expect(customProvider.config.apiKeyHeader).toBe('Authorization')
            expect(customProvider.config.models).toEqual([{ modelId: 'm', modelName: 'M', modelType: AIProviderModelType.TEXT }])
        })

        it('should include config with defaultHeaders when the engine lists providers', async () => {
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

            const response = await app!.inject({
                method: 'GET',
                url: '/api/v1/ai-providers',
                headers: { authorization: `Bearer ${await mockEngineToken()}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            const customProvider = body.find(
                (p: any) => p.provider === AIProviderName.CUSTOM,
            )
            expect(customProvider).toBeDefined()
            expect(customProvider.config.defaultHeaders).toEqual({ 'X-Test': 'test' })
        })
    })

    describe('authorization on the mutating routes', () => {
        // A platform MEMBER holding the *widest* project role there is. If even this principal is
        // refused, so is the read-only member the ticket describes; a test built on VIEWER could
        // not tell "platform-admin is required" from "some project permission is required".
        const platformMember = () => createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

        it('should refuse a create from a platform member who is not a platform admin', async () => {
            const member = await platformMember()

            const response = await member.post('/v1/ai-providers', customProviderBody({
                displayName: 'Attacker endpoint',
                config: {
                    baseUrl: 'https://attacker.example/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                enabledForChat: true,
            }))

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response?.json().code).toBe(ErrorCode.AUTHORIZATION)

            const saved = await db.findOneBy('ai_provider', { platformId: ctx.platform.id })
            expect(saved).toBeNull()
        })

        it('should refuse an update from a platform member who is not a platform admin', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'The real provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })
            const member = await platformMember()

            const response = await member.post(`/v1/ai-providers/${provider.id}`, {
                config: {
                    baseUrl: 'https://attacker.example/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
                enabledForChat: true,
            })

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response?.json().code).toBe(ErrorCode.AUTHORIZATION)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).config.baseUrl).toBe('https://api.example.com/v1')
            expect((saved as any).enabledForChat).toBe(false)
        })

        it('should refuse a delete from a platform member who is not a platform admin', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Not yours to delete',
            })
            const member = await platformMember()

            const response = await member.delete(`/v1/ai-providers/${provider.id}`)

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response?.json().code).toBe(ErrorCode.AUTHORIZATION)

            const stillThere = await db.findOneBy('ai_provider', { id: provider.id })
            expect(stillThere).not.toBeNull()
        })

        it('should still let a platform admin create, update and delete', async () => {
            const created = await ctx.post('/v1/ai-providers', customProviderBody({ displayName: 'Admin created' }))
            expect(created?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneByOrFail('ai_provider', {
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
            })

            const updated = await ctx.post(`/v1/ai-providers/${(saved as any).id}`, { displayName: 'Admin renamed' })
            expect(updated?.statusCode).toBe(StatusCodes.OK)

            const deleted = await ctx.delete(`/v1/ai-providers/${(saved as any).id}`)
            expect(deleted?.statusCode).toBe(StatusCodes.NO_CONTENT)
            expect(await db.findOneBy('ai_provider', { id: (saved as any).id })).toBeNull()
        })

        // The read routes are deliberately left open to any platform member: the builder's agent
        // step settings list providers and then that provider's models. Pinning it here so a later
        // blanket tightening has to argue with a test rather than silently break the picker.
        it('should still let a platform member read the provider list and a provider\'s models', async () => {
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Readable',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{ modelId: 'm', modelName: 'M', modelType: AIProviderModelType.TEXT }],
                },
            })
            const member = await platformMember()

            const list = await member.get('/v1/ai-providers')
            expect(list?.statusCode).toBe(StatusCodes.OK)
            expect(list?.json()).toHaveLength(1)

            const models = await member.get(`/v1/ai-providers/${AIProviderName.CUSTOM}/models`)
            expect(models?.statusCode).toBe(StatusCodes.OK)
            expect(models?.json()).toEqual([{ id: 'm', name: 'M', type: AIProviderModelType.TEXT }])
        })
    })

    describe('config.models size caps', () => {
        it('should accept a models list at the cap', async () => {
            const response = await ctx.post('/v1/ai-providers', customProviderBody({
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: modelList(200),
                },
            }))

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })

        it('should reject a create whose models list is over the cap', async () => {
            const response = await ctx.post('/v1/ai-providers', customProviderBody({
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: modelList(201),
                },
            }))

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            // The message has to be a key the web app can translate, not an English sentence.
            expect(response?.body).toContain('tooManyModels')
            expect(await db.findOneBy('ai_provider', { platformId: ctx.platform.id })).toBeNull()
        })

        it('should reject a create whose modelId is over the length cap', async () => {
            const response = await ctx.post('/v1/ai-providers', customProviderBody({
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{
                        modelId: 'm'.repeat(201),
                        modelName: 'Oversized',
                        modelType: AIProviderModelType.TEXT,
                    }],
                },
            }))

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.body).toContain('modelIdentifierTooLong')
            expect(await db.findOneBy('ai_provider', { platformId: ctx.platform.id })).toBeNull()
        })

        it('should reject a create whose modelName is over the length cap', async () => {
            const response = await ctx.post('/v1/ai-providers', customProviderBody({
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{
                        modelId: 'fits',
                        modelName: 'n'.repeat(201),
                        modelType: AIProviderModelType.TEXT,
                    }],
                },
            }))

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.body).toContain('modelIdentifierTooLong')
            expect(await db.findOneBy('ai_provider', { platformId: ctx.platform.id })).toBeNull()
        })

        // Without this the cap is only pinned from above: tightening 200 to 199 would break real
        // catalogues and every assertion would stay green, exactly as the array cap's own
        // at-the-cap case exists to prevent.
        it('should accept identifiers of exactly the cap length', async () => {
            const response = await ctx.post('/v1/ai-providers', customProviderBody({
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [{
                        modelId: 'm'.repeat(200),
                        modelName: 'n'.repeat(200),
                        modelType: AIProviderModelType.TEXT,
                    }],
                },
            }))

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const saved = await db.findOneByOrFail('ai_provider', { platformId: ctx.platform.id })
            expect((saved as any).config.models[0].modelId).toHaveLength(200)
            expect((saved as any).config.models[0].modelName).toHaveLength(200)
        })

        // The abuse loop in the ticket is `POST /:id` repeated, so the cap has to hold on the
        // update path too. It lands as a 409 rather than a 400 because `UpdateAIProviderRequest`
        // carries the untagged config union: an oversized custom config falls through to the
        // union's empty tail and is then rejected by the per-provider re-parse added in #272.
        it('should reject an update whose models list is over the cap', async () => {
            const provider = await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Bounded',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post(`/v1/ai-providers/${provider.id}`, {
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: modelList(201),
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response?.json().code).toBe(ErrorCode.VALIDATION)

            const saved = await db.findOneByOrFail('ai_provider', { id: provider.id })
            expect((saved as any).config.models).toHaveLength(0)
        })
    })

    describe('custom providers per platform cap', () => {
        // The cap is the only thing refusing this row. The index that used to make a second custom
        // provider impossible is partial now and skips `custom` entirely, so deleting the
        // `assertCustomProviderLimitNotExceeded` call returns 200 here rather than the 409 it would
        // have returned before #274 — the assertion discriminates the cap, not the index.
        it('should reject the (N+1)th custom provider with RESOURCE_LIMIT_EXCEEDED/403', async () => {
            setMaxCustomProvidersOverride('1')
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'The one allowed custom provider',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            const response = await ctx.post('/v1/ai-providers', customProviderBody({ displayName: 'One too many' }))

            expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
            const body = response?.json()
            expect(body.code).toBe(ErrorCode.RESOURCE_LIMIT_EXCEEDED)
            expect(body.params.resource).toBe('custom_ai_providers')
            expect(body.params.limit).toBe(1)
            // `resource` and `limit` are machine vocabulary. Without a sentence the upsert dialog
            // fell through to `JSON.stringify(error)`, which on an AxiosError serialises `config`
            // — the Authorization header and the request body, i.e. the admin's own bearer token
            // and the provider api key they had just typed — straight into the form.
            expect(body.params.message).toBe(CUSTOM_PROVIDER_LIMIT_MESSAGE)
        })

        it('should still allow a custom provider while the platform is under the cap', async () => {
            setMaxCustomProvidersOverride('1')

            const response = await ctx.post('/v1/ai-providers', customProviderBody({ displayName: 'The first one' }))

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })

        it('should not apply the custom cap to the single-instance provider types', async () => {
            setMaxCustomProvidersOverride('1')
            await mockAndSaveAIProvider({
                platformId: ctx.platform.id,
                provider: AIProviderName.CUSTOM,
                displayName: 'Fills the custom quota',
                config: {
                    baseUrl: 'https://api.example.com/v1',
                    apiKeyHeader: 'Authorization',
                    models: [],
                },
            })

            // Cloudflare Gateway with no models is the other provider whose validateConnection
            // makes no network call, so this stays an offline test.
            const response = await ctx.post('/v1/ai-providers', {
                provider: AIProviderName.CLOUDFLARE_GATEWAY,
                displayName: 'Gateway',
                config: { accountId: 'acc', gatewayId: 'gw', models: [] },
                auth: { apiKey: 'test-key' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })

        // A non-positive override must not read as "no cap", and must not read as a *literal* cap
        // either: with the `<= 0` half of the fallback removed, `current >= limit` is `0 >= 0` and
        // `0 >= -1` on an empty platform, so both of these creates would be refused. That is the
        // half of `getMaxCustomProvidersPerPlatform` a create-succeeds assertion can actually see
        // from the wired path; the rest is pinned in test/unit/app/ai/ai-provider-limit.test.ts,
        // because observing a resolved limit of twenty from here costs twenty creates to pin one
        // number.
        it.each(['not-a-number', '0', '-1', ''])('should fall back to the built-in cap when the override is %j', async (override) => {
            setMaxCustomProvidersOverride(override)

            const response = await ctx.post('/v1/ai-providers', customProviderBody({ displayName: 'Still allowed' }))

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })
    })
})

async function mockEngineToken(): Promise<string> {
    return generateMockToken({
        type: PrincipalType.ENGINE,
        id: apId(),
        projectId: ctx.project.id,
        platform: { id: ctx.platform.id },
    })
}

async function mockAndSaveCustomProvider({ platformId, displayName, created, baseUrl }: MockCustomProviderParams): Promise<Omit<AIProviderSchema, 'platform'>> {
    return mockAndSaveAIProvider({
        platformId,
        provider: AIProviderName.CUSTOM,
        displayName,
        created,
        config: { baseUrl, apiKeyHeader: 'Authorization', models: [] },
    })
}

type MockCustomProviderParams = {
    platformId: string
    displayName: string
    created: string
    baseUrl: string
}

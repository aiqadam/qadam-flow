import http from 'node:http'
import { AddressInfo } from 'node:net'
import {
    AIProviderModelType,
    AIProviderName,
    apId,
    AppConnectionStatus,
    AppConnectionType,
    ChatConversationStatus,
    DefaultProjectRole,
    PersistedChatPartType,
    PersistedChatRole,
    Project,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { db } from '../../../helpers/db'
import { createMockConnection, createMockProject } from '../../../helpers/mocks'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

const MODEL_ID = 'test-chat-model'

// A real loopback server rather than a stubbed `fetch`. The provider request does not go through
// the global fetch at all — `chatAiUtils.createChatModel` hands the SDK `safeHttp.fetch`, which
// runs on the SSRF-filtered axios instance — so a `vi.stubGlobal('fetch', …)` silently fails to
// intercept and the suite tries to resolve a real hostname. Standing up an actual server keeps the
// whole transport under test, SSRF filter included, which is the part most likely to break chat.
// Loopback is exactly what that filter blocks, hence the allow list; it is read once, lazily, when
// the axios singleton is first built, and nothing in this process touches it before the first run.
process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'

let providerServer: http.Server
let providerOrigin: string
let providerBaseUrl: string
let providerReply = 'Hello from the test model'
let providerCalls: string[] = []
let providerBodies: Record<string, unknown>[] = []

beforeAll(async () => {
    providerServer = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
            providerCalls.push(`${providerOrigin}${req.url}`)
            providerBodies.push(JSON.parse(Buffer.concat(chunks).toString()))
            res.writeHead(StatusCodes.OK, { 'content-type': 'text/event-stream' })
            res.end(completionStream(providerReply))
        })
    })
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve))
    providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`
    providerBaseUrl = `${providerOrigin}/v1`
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
    await new Promise<void>((resolve, reject) => providerServer.close((err) => err ? reject(err) : resolve()))
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

afterEach(() => {
    providerCalls = []
    providerBodies = []
    providerReply = 'Hello from the test model'
})

async function createConversation(context: TestContext, body: Record<string, unknown> = {}): Promise<string> {
    const response = await context.post('/v1/chat/conversations', body)
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response!.json().id
}

/**
 * An OpenAI-compatible provider is used on purpose: its model catalogue lives in the stored
 * config, so resolving a model needs no network call and the only outbound request left to fake
 * is the completion itself.
 */
async function enableChatProvider(platformId: string, models = [{ modelId: MODEL_ID, modelName: 'Test chat model', modelType: AIProviderModelType.TEXT }]): Promise<void> {
    await db.save('ai_provider', {
        id: apId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        platformId,
        provider: AIProviderName.CUSTOM,
        displayName: 'Test provider',
        auth: await encryptUtils.encryptObject({ apiKey: 'sk-must-never-be-logged' }),
        config: {
            apiKeyHeader: 'Authorization',
            baseUrl: providerBaseUrl,
            models,
        },
        enabledForChat: true,
    })
}

function sseChunk(payload: Record<string, unknown>): string {
    return `data: ${JSON.stringify(payload)}\n\n`
}

function completionStream(text: string): string {
    return [
        sseChunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        }),
        sseChunk({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
        'data: [DONE]\n\n',
    ].join('')
}

async function waitForStatus(conversationId: string, status: ChatConversationStatus): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
        if (row?.status === status) {
            return row
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Conversation ${conversationId} never reached ${status}`)
}

async function saveProjectWithConnection({ platformId, ownerId, qadamName, displayName }: {
    platformId: string
    ownerId: string
    qadamName: string
    displayName: string
}): Promise<Project> {
    const project = createMockProject({ platformId, ownerId })
    await db.save('project', project)
    const connection = createMockConnection({
        platformId,
        projectIds: [project.id],
        qadamName,
        displayName,
        status: AppConnectionStatus.ACTIVE,
    }, ownerId)
    await db.save('app_connection', {
        ...connection,
        value: await encryptUtils.encryptObject({ type: AppConnectionType.SECRET_TEXT, secret_text: 'shh' }),
    })
    return project
}

describe('Chat agent API', () => {
    describe('POST /v1/chat/conversations/:id/messages', () => {
        it('refuses with a stated cause, not a 500, when no AI provider is enabled for chat', async () => {
            const conversationId = await createConversation(ctx)

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'automate my inbox',
                runId: apId(),
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response!.json().code).toBe('AI_REQUEST_NOT_SUPPORTED')
            expect(response!.json().params.message).toContain('No AI provider is enabled for chat')
            // The run must not have been admitted — a conversation left in STREAMING with no loop
            // behind it would spin the client's stale-check forever.
            const saved = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
            expect(saved?.status).toBe(ChatConversationStatus.IDLE)
        })

        it('starts the run and answers with the conversation and run ids when a provider is configured', async () => {
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(ctx)
            const runId = apId()

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'say hello',
                runId,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json()).toEqual({ conversationId, runId })

            const finished = await waitForStatus(conversationId, ChatConversationStatus.IDLE)
            expect(providerCalls).toEqual([`${providerBaseUrl}/chat/completions`])
            // The whole Qadam Flow tool set reaches the provider, including the chat-only
            // thinking-status tool the system prompt requires before every other call.
            const toolNames = (providerBodies[0].tools as any[]).map((tool: any) => tool.function.name)
            expect(toolNames).toContain('ap_update_thinking_status')
            expect(toolNames).toContain('ap_run_action')
            expect(toolNames).toContain('ap_build_flow')
            // Names alone would not prove the tools are usable: the MCP definitions carry a raw Zod
            // shape rather than a schema, and a wrapping that lost it would register every tool
            // with empty parameters — the model would then call them with no arguments and every
            // call would fail at the handler, with the wiring still looking correct from here.
            const runAction = (providerBodies[0].tools as any[]).find((tool: any) => tool.function.name === 'ap_run_action')
            expect(Object.keys(runAction.function.parameters.properties)).toEqual(
                expect.arrayContaining(['qadamName', 'actionName', 'input']),
            )
            expect(finished.uiMessages).toEqual([
                { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'say hello' }] },
                { role: PersistedChatRole.ASSISTANT, parts: [{ type: PersistedChatPartType.TEXT, text: 'Hello from the test model' }] },
            ])
            // The run is bound to the caller's project, so every tool in it is too.
            expect(finished.projectId).toBe(ctx.project.id)
        })

        // The provider is reachable and enabled; it just offers no text model. Exercises the
        // catalogue fallback added on top of the stored config — without it a platform on OpenAI,
        // Anthropic or Google (none of which store a catalogue) could never send a first message,
        // because no chat UI component sets `modelName`.
        it('names the missing model rather than failing opaquely when the provider offers none', async () => {
            await enableChatProvider(ctx.platform.id, [])
            const conversationId = await createConversation(ctx)

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'say hello',
                runId: apId(),
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response!.json().code).toBe('AI_MODEL_NOT_SUPPORTED')
            expect(providerCalls).toEqual([])
        })

        it('refuses a second message while the first is still generating, instead of losing a turn', async () => {
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(ctx)
            await db.update('chat_conversation', conversationId, { status: ChatConversationStatus.STREAMING })

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'and another thing',
                runId: apId(),
            })

            // 409, not 400: `ErrorCode.VALIDATION` maps to CONFLICT in `error-handler.ts`, which
            // is the right reading anyway — the request is well formed, the conversation is busy.
            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response!.json().params.message).toContain('already generating a reply')
            expect(providerCalls).toEqual([])
        })

        it('refuses a platform sibling attempt to post into someone else conversation', async () => {
            await enableChatProvider(ctx.platform.id)
            // Same platform on purpose — two createTestContext calls would give two different
            // platforms and the test would pass under platform-only scoping.
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const conversationId = await createConversation(ctx)

            const response = await sibling.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'hijacked',
                runId: apId(),
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            const saved = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
            expect(saved?.status).toBe(ChatConversationStatus.IDLE)
            expect(saved?.uiMessages).toBeNull()
        })
    })

    describe('GET /v1/chat/conversations/:id/connections', () => {
        it('returns only the conversation own project connections, not a sibling project ones', async () => {
            const qadamName = '@aiqadam/qadam-slack'
            const mine = createMockConnection({
                platformId: ctx.platform.id,
                projectIds: [ctx.project.id],
                qadamName,
                displayName: 'mine',
                status: AppConnectionStatus.ACTIVE,
            }, ctx.user.id)
            await db.save('app_connection', {
                ...mine,
                value: await encryptUtils.encryptObject({ type: AppConnectionType.SECRET_TEXT, secret_text: 'shh' }),
            })
            // A second project on the SAME platform — platform-only scoping would leak it.
            await saveProjectWithConnection({
                platformId: ctx.platform.id,
                ownerId: ctx.user.id,
                qadamName,
                displayName: 'theirs',
            })

            const conversationId = await createConversation(ctx)
            await db.update('chat_conversation', conversationId, { projectId: ctx.project.id })

            const response = await ctx.get(`/v1/chat/conversations/${conversationId}/connections`, { qadamName })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const labels = response!.json().map((row: Record<string, string>) => row.label)
            expect(labels).toEqual(['mine'])
            expect(response!.json()[0].projectId).toBe(ctx.project.id)
        })

        it('refuses to read a platform sibling conversation connections', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const conversationId = await createConversation(sibling)

            const response = await ctx.get(`/v1/chat/conversations/${conversationId}/connections`, {
                qadamName: '@aiqadam/qadam-slack',
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('gates that are not implemented in this layer', () => {
        it('reports no pending gate rather than inventing one', async () => {
            const conversationId = await createConversation(ctx)

            const response = await ctx.get(`/v1/chat/conversations/${conversationId}/pending-gate`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json()).toBeNull()
        })

        it('404s a tool approval rather than reporting a success that approved nothing', async () => {
            const response = await ctx.post(`/v1/chat/tool-approvals/${apId()}`, { approved: true })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('POST /v1/chat/conversations/:id/cancel', () => {
        it('accepts a cancel for the caller own conversation', async () => {
            const conversationId = await createConversation(ctx)

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/cancel`)

            expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
        })

        it('refuses to cancel a platform sibling run', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const conversationId = await createConversation(sibling)

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/cancel`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })
})

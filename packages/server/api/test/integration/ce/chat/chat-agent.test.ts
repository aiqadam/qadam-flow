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
    isNil,
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
let scriptedResponses: string[] = []
let providerHold: Promise<void> | null = null
let providerFirstChunkOnly = ''
let providerStreamedFirstChunk = false

beforeAll(async () => {
    providerServer = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
            providerCalls.push(`${providerOrigin}${req.url}`)
            providerBodies.push(JSON.parse(Buffer.concat(chunks).toString()))
            res.writeHead(StatusCodes.OK, { 'content-type': 'text/event-stream' })
            // Held open, one chunk sent, when a test needs a run that is genuinely mid-stream —
            // the only way to cancel something real rather than a conversation that is already
            // finished.
            if (!isNil(providerHold)) {
                const hold = providerHold
                providerHold = null
                res.write(textChunk(providerFirstChunkOnly))
                providerStreamedFirstChunk = true
                void hold.then(() => res.end('data: [DONE]\n\n'))
                return
            }
            // A queued script when the test set one, so a turn that calls a tool can answer
            // differently on the model's second request; otherwise the plain reply.
            res.end(scriptedResponses.shift() ?? completionStream(providerReply))
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
    scriptedResponses = []
    providerHold = null
    providerFirstChunkOnly = ''
    providerStreamedFirstChunk = false
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

function textChunk(text: string): string {
    return sseChunk({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Condition never became true')
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

function toolCallStream({ toolName, callId, args }: { toolName: string, callId: string, args: string }): string {
    return [
        sseChunk({
            id: 'chatcmpl-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{
                index: 0,
                delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: args } }] },
                finish_reason: null,
            }],
        }),
        sseChunk({
            id: 'chatcmpl-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }),
        'data: [DONE]\n\n',
    ].join('')
}

async function waitForCondition(read: () => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const row = await read()
        if (row !== null) {
            return row
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Condition never became true')
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

        // The suite otherwise only ever streams plain text, which proves the tools are *declared*
        // to the provider and never that one can be *run*. This drives a real tool call through
        // the adapter, the project-scoped handler and the persistence, and then a second turn so
        // the replayed transcript is exercised too.
        it('runs a tool the model asks for, and replays that turn to the model on the next message', async () => {
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(ctx)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_list_flows', callId: 'call_1', args: '{}' }),
                completionStream('You have no flows yet.'),
            ]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
            const afterFirst = await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            // Two provider round-trips: the tool call, then the answer built from its result.
            expect(providerCalls).toHaveLength(2)
            const toolMessage = (providerBodies[1].messages as any[]).find((message: any) => message.role === 'tool')
            expect(toolMessage).toBeDefined()
            const persistedParts = (afterFirst.uiMessages as any[])[1].parts
            expect(persistedParts.some((part: any) => part.type === PersistedChatPartType.TOOL_CALL && part.toolName === 'ap_list_flows')).toBe(true)

            // Second turn: the stored tool call and its result must come back as a valid
            // assistant+tool pair, or the provider rejects the transcript for unanswered calls.
            providerCalls = []
            providerBodies = []
            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'and now?', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const replayed = providerBodies[0].messages as any[]
            const assistantWithCall = replayed.find((message: any) => message.role === 'assistant' && JSON.stringify(message).includes('ap_list_flows'))
            expect(assistantWithCall).toBeDefined()
            const replayedToolResult = replayed.find((message: any) => message.role === 'tool')
            expect(replayedToolResult).toBeDefined()
            expect(replayed.filter((message: any) => message.role === 'user')).toHaveLength(2)
        })

        // Chat drives the same tools the REST API guards with `Permission.*`. Until this landed,
        // `resolvePermissionChecker` returned ALLOW_ALL, so a Viewer could ask the assistant to do
        // what the API would have refused them.
        it('refuses a write tool for a project member whose role does not grant it', async () => {
            const viewer = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.VIEWER })
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(viewer)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_create_flow', callId: 'call_1', args: JSON.stringify({ flowName: 'sneaky flow' }) }),
                completionStream('I could not do that.'),
            ]

            await viewer.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'create a flow', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const toolMessage = (providerBodies[1].messages as any[]).find((message: any) => message.role === 'tool')
            expect(JSON.stringify(toolMessage)).toContain('do not have permission')
            // The refusal has to be real, not just a message: nothing may have been created.
            expect(await db.findOneBy('flow', { projectId: ctx.project.id })).toBeNull()
        })

        it('allows a read tool for that same member, so the check is a permission check and not a blanket block', async () => {
            const viewer = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.VIEWER })
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(viewer)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_list_flows', callId: 'call_1', args: '{}' }),
                completionStream('You have no flows.'),
            ]

            await viewer.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const toolMessage = (providerBodies[1].messages as any[]).find((message: any) => message.role === 'tool')
            // Matches the whole refusal family, not one phrase: a blanket DENY_ALL answers with
            // "cannot run here" instead, and an assertion that only looked for "do not have
            // permission" would call that a pass.
            expect(JSON.stringify(toolMessage)).not.toMatch(/do not have permission|cannot run here|do not have access/)
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

        // An API restart mid-run is routine on a self-hosted upgrade, and it leaves a STREAMING row
        // with no process behind it. Without a way out the conversation is dead: every later
        // message 409s and the client polls a status that will never change.
        it('takes over a run abandoned by a restarted process instead of wedging the conversation', async () => {
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(ctx)
            const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
            await db.update('chat_conversation', conversationId, { status: ChatConversationStatus.STREAMING, updated: longAgo })

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, {
                content: 'are you still there',
                runId: apId(),
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)
        })

        // The step cap bounds one run. Nothing bounded how many a single account starts, and each
        // one is worth up to 25 paid round-trips on the operator's provider bill.
        it('refuses to start more concurrent runs than one user is allowed', async () => {
            await enableChatProvider(ctx.platform.id)
            const busy = await Promise.all([1, 2, 3].map(() => createConversation(ctx)))
            for (const conversationId of busy) {
                await db.update('chat_conversation', conversationId, { status: ChatConversationStatus.STREAMING })
            }
            const fourth = await createConversation(ctx)

            const response = await ctx.post(`/v1/chat/conversations/${fourth}/messages`, {
                content: 'and one more',
                runId: apId(),
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response!.json().params.message).toContain('several replies generating')
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

        // Owning the conversation is not the same as still being entitled to the project it was
        // pinned to. The run loop re-checks that on every turn; this path has to as well, or a
        // removed member keeps a working read of the project's connection inventory.
        it('stops listing a project connections once the caller loses access to that project', async () => {
            const member = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            await enableChatProvider(ctx.platform.id)
            const connection = createMockConnection({
                platformId: ctx.platform.id,
                projectIds: [ctx.project.id],
                qadamName: '@aiqadam/qadam-slack',
                displayName: 'shared slack',
                status: AppConnectionStatus.ACTIVE,
            }, ctx.user.id)
            await db.save('app_connection', {
                ...connection,
                value: await encryptUtils.encryptObject({ type: AppConnectionType.SECRET_TEXT, secret_text: 'shh' }),
            })
            const conversationId = await createConversation(member)
            await db.update('chat_conversation', conversationId, { projectId: ctx.project.id })

            const before = await member.get(`/v1/chat/conversations/${conversationId}/connections`, { qadamName: 'slack' })
            expect(before!.json().map((row: Record<string, string>) => row.label)).toEqual(['shared slack'])

            await db.delete('project_member', { userId: member.user.id, projectId: ctx.project.id })

            const after = await member.get(`/v1/chat/conversations/${conversationId}/connections`, { qadamName: 'slack' })
            expect(after?.statusCode).toBe(StatusCodes.OK)
            expect(after!.json()).toEqual([])
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

        // Cancelling an idle conversation, as the case above does, aborts nothing — there is no
        // controller registered — so it proves only that the route answers. This cancels a run
        // that is genuinely mid-stream and checks the two things that actually matter: the
        // conversation settles back to IDLE rather than ERROR, and the partial reply survives.
        it('stops a live run, keeps what was already streamed, and does not report it as a failure', async () => {
            await enableChatProvider(ctx.platform.id)
            const conversationId = await createConversation(ctx)
            let releaseRest: () => void = () => {}
            const restReleased = new Promise<void>((resolve) => {
                releaseRest = resolve
            })
            providerHold = restReleased
            providerFirstChunkOnly = 'Partial answer so far'

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'say something long', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.STREAMING)
            // Wait until the first token has actually been streamed, otherwise the cancel races
            // the stream opening and there would be nothing partial to preserve.
            await waitFor(() => providerStreamedFirstChunk)

            const cancelled = await ctx.post(`/v1/chat/conversations/${conversationId}/cancel`)
            expect(cancelled?.statusCode).toBe(StatusCodes.NO_CONTENT)
            releaseRest()

            // Waiting on the assistant turn, not on IDLE: the cancel endpoint settles the status
            // itself so that a run owned by another process still unsticks, which means IDLE can
            // land before the loop has written what it managed to stream.
            const settled = await waitForCondition(async () => {
                const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
                return (row?.uiMessages as any[])?.length === 2 ? row : null
            })
            expect(settled.status).toBe(ChatConversationStatus.IDLE)
            expect((settled.uiMessages as any[])[1].parts[0].text).toContain('Partial answer so far')
        })

        // The abort controller lives in the process that started the run. A cancel arriving at any
        // other instance — or after that instance restarted — must still settle the row, or the
        // user is left with a stop button that answers 204 and changes nothing.
        it('settles a conversation left streaming by another process', async () => {
            const conversationId = await createConversation(ctx)
            await db.update('chat_conversation', conversationId, { status: ChatConversationStatus.STREAMING })

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/cancel`)

            expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
            const settled = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
            expect(settled?.status).toBe(ChatConversationStatus.IDLE)
        })

        it('refuses to cancel a platform sibling run', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const conversationId = await createConversation(sibling)

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/cancel`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })
})

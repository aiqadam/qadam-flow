/**
 * #264. Baseline first: this file is written and run BEFORE any gating exists, so the assertions
 * below describe the behaviour we want and must fail against the pre-change code. Watching them go
 * red is the only thing that proves they test the gate rather than testing nothing — a suite added
 * after the fix would pass on day one and keep passing if the gate were later removed.
 *
 * The tool is driven through the scripted provider rather than called directly, because the whole
 * point of #264 is that the *model* cannot reach a destructive tool without a human in between:
 * a unit test on the gating predicate would not notice if the predicate were never wired into
 * `toAiSdkTool`.
 */
import http from 'node:http'
import { AddressInfo } from 'node:net'
import {
    AIProviderModelType,
    AIProviderName,
    apId,
    ChatConversationStatus,
    DefaultProjectRole,
    FieldType,
    FlowVersionState,
    isNil,
    PendingChatToolApproval,
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockTable } from '../../../helpers/mocks'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

const MODEL_ID = 'test-chat-model'

// Same reasoning as `chat-agent.test.ts`: the provider request goes through `safeHttp.fetch`, so a
// stubbed global `fetch` silently fails to intercept. A real loopback server keeps the transport
// under test, which means the allow list is required.
process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'

let providerServer: http.Server
let providerOrigin: string
let providerBaseUrl: string
let providerBodies: Record<string, unknown>[] = []
let scriptedResponses: string[] = []

function sseChunk(payload: Record<string, unknown>): string {
    return `data: ${JSON.stringify(payload)}\n\n`
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

// Two gated calls in one step, which is the shape the `toolCallId` check exists for: the model can
// ask for both at once, so the endpoint has to answer the gate it was addressed with rather than
// whichever one the caller names.
function twoToolCallStream(calls: { toolName: string, callId: string, args: string }[]): string {
    return [
        sseChunk({
            id: 'chatcmpl-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{
                index: 0,
                delta: {
                    role: 'assistant',
                    tool_calls: calls.map((call, index) => ({
                        index,
                        id: call.callId,
                        type: 'function',
                        function: { name: call.toolName, arguments: call.args },
                    })),
                },
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

function completionStream(text: string): string {
    return [
        sseChunk({
            id: 'chatcmpl-text',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        }),
        sseChunk({
            id: 'chatcmpl-text',
            object: 'chat.completion.chunk',
            created: 1,
            model: MODEL_ID,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
        'data: [DONE]\n\n',
    ].join('')
}

beforeAll(async () => {
    providerServer = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
            providerBodies.push(JSON.parse(Buffer.concat(chunks).toString()))
            res.writeHead(StatusCodes.OK, { 'content-type': 'text/event-stream' })
            const scripted = scriptedResponses.shift()
            res.end(scripted ?? completionStream('Nothing scripted.'))
        })
    })
    await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve))
    const port = (providerServer.address() as AddressInfo).port
    providerOrigin = `http://127.0.0.1:${port}`
    providerBaseUrl = `${providerOrigin}/v1`
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
    await new Promise<void>((resolve, reject) => providerServer.close((err) => err ? reject(err) : resolve()))
})

beforeEach(async () => {
    providerBodies = []
    scriptedResponses = []
    if (isNil(app)) {
        throw new Error('test environment was not set up')
    }
    ctx = await createTestContext(app)
})

async function enableChatProvider(platformId: string): Promise<void> {
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
            models: [{ modelId: MODEL_ID, modelName: 'Test chat model', modelType: AIProviderModelType.TEXT }],
        },
        enabledForChat: true,
    })
}

async function createConversation(context: TestContext): Promise<string> {
    const response = await context.post('/v1/chat/conversations', {})
    return (response.json() as { id: string }).id
}

async function waitForStatus(conversationId: string, status: ChatConversationStatus): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
        if (!isNil(row) && row['status'] === status) {
            return row
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`conversation ${conversationId} never reached ${status}`)
}

async function createFlow(): Promise<{ id: string }> {
    const flow = createMockFlow({ projectId: ctx.project.id })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.DRAFT })
    await db.save('flow_version', flowVersion)
    return { id: flow.id }
}

async function createTable(): Promise<{ id: string }> {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    return { id: table.id }
}

async function readPendingGate(conversationId: string): Promise<PendingChatToolApproval | null> {
    const response = await ctx.get(`/v1/chat/conversations/${conversationId}/pending-gate`)
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response!.json()
}

async function readParts(conversationId: string): Promise<PersistedChatPart[]> {
    const row = await db.findOneByOrFail<Record<string, unknown>>('chat_conversation', { id: conversationId })
    return (row['uiMessages'] as PersistedChatMessage[] ?? []).flatMap((message) => message.parts)
}

// One place for "get a conversation into the state where a gate is waiting", because every case
// below starts there and the interesting part of each is what happens next.
async function raiseGate({ toolName, args, resumeReply = 'Done.' }: {
    toolName: string
    args: Record<string, unknown>
    resumeReply?: string
}): Promise<{ conversationId: string, gate: PendingChatToolApproval }> {
    await enableChatProvider(ctx.platform.id)
    const conversationId = await createConversation(ctx)
    scriptedResponses = [
        toolCallStream({ toolName, callId: 'call_1', args: JSON.stringify(args) }),
        completionStream(resumeReply),
    ]

    await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'do the thing', runId: apId() })
    await waitForStatus(conversationId, ChatConversationStatus.IDLE)

    const gate = await readPendingGate(conversationId)
    if (isNil(gate)) {
        throw new Error('no gate was raised, so nothing below is testing what it claims to')
    }
    return { conversationId, gate }
}

describe('Chat tool approval gates (#264)', () => {
    describe('a destructive tool the model asked for', () => {
        // The whole hole, in one assertion: today the model says "delete it" and the flow is gone,
        // with no human in the loop. Prompt injection reaching the model is therefore enough to
        // destroy a user's work. This test MUST fail before the gate exists.
        it('is not executed on the model\'s word alone — the flow survives', async () => {
            await enableChatProvider(ctx.platform.id)
            const flow = await createFlow()
            const conversationId = await createConversation(ctx)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_delete_flow', callId: 'call_1', args: JSON.stringify({ flowId: flow.id }) }),
                completionStream('Done, I deleted it.'),
            ]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'delete that flow', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const stillThere = await db.findOneBy('flow', { id: flow.id })
            expect(stillThere, 'ap_delete_flow ran without any human approval').not.toBeNull()
        })

        // The second half of the same property, and the one that says the run *stopped* rather than
        // merely failing: a gated call ends the run, so the model never gets a second turn in which
        // it could report a result it never received.
        it('ends the run instead of giving the model another turn', async () => {
            await enableChatProvider(ctx.platform.id)
            const flow = await createFlow()
            const conversationId = await createConversation(ctx)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_delete_flow', callId: 'call_1', args: JSON.stringify({ flowId: flow.id }) }),
                completionStream('Done, I deleted it.'),
            ]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'delete that flow', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            expect(providerBodies.length, 'the run continued past the gated call').toBe(1)
        })

        // The gate stopping the call is only half of it. The gated call produces no result, and a
        // result-less call used to be persisted as a failed one — so the next turn told the model
        // "the tool failed", and it would apologise or retry rather than wait for the human. The
        // pending gate has to be persisted as itself.
        it('is persisted as a pending approval request, not as a failed tool call', async () => {
            await enableChatProvider(ctx.platform.id)
            const flow = await createFlow()
            const conversationId = await createConversation(ctx)
            scriptedResponses = [
                toolCallStream({ toolName: 'ap_delete_flow', callId: 'call_1', args: JSON.stringify({ flowId: flow.id }) }),
                completionStream('Done, I deleted it.'),
            ]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'delete that flow', runId: apId() })
            const row = await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const parts = (row['uiMessages'] as PersistedChatMessage[]).flatMap((message) => message.parts)
            const approvalRequests = parts.filter((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST)
            expect(approvalRequests, 'the pending gate was not persisted').toEqual([
                expect.objectContaining({
                    toolCallId: 'call_1',
                    toolName: 'ap_delete_flow',
                    input: { flowId: flow.id },
                }),
            ])
            expect(approvalRequests[0]).toHaveProperty('approvalId', expect.any(String))
            // The bug itself: the same call recorded a second time as a failure is what tells the
            // model on the next turn that deleting the flow was attempted and did not work.
            expect(
                parts.filter((part) => part.type === PersistedChatPartType.TOOL_CALL && part.toolCallId === 'call_1'),
                'the gated call was also recorded as a tool call, so the model will be told it failed',
            ).toEqual([])
        })
    })

    describe('GET /conversations/:id/pending-gate', () => {
        it('reports the waiting gate with the tool and the arguments it was asked with', async () => {
            const flow = await createFlow()
            const { gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })

            // The input is the whole point. A card that says only "Delete flow" asks the user to
            // approve an action they cannot see, which is indistinguishable from no gate at all.
            expect(gate).toEqual({
                gateId: expect.any(String),
                toolCallId: 'call_1',
                toolName: 'ap_delete_flow',
                displayName: 'Delete flow',
                toolInput: { flowId: flow.id },
            })
        })

        it('reports nothing once the gate has been answered', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })

            await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: false })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            expect(await readPendingGate(conversationId), 'an answered gate is still offered, so the card never goes away').toBeNull()
        })
    })

    describe('POST /conversations/:id/tool-approvals/:gateId', () => {
        // Owner binding, and the reason the route is nested under the conversation. User B knows both
        // ids — an approval id travels through a socket payload and a rendered card, so it is not a
        // secret — and must still be unable to spend the gate. 404 rather than 403 for the same
        // reason `getOneOrThrow` does it: a 403 would confirm the conversation exists.
        // Note for the next reader: this pins the *outcome*, not a specific layer. Ownership is
        // checked twice — `getOneOrThrow` in the approve path and `admitRun`'s own
        // `{id, platformId, userId}` filter — so this test still passes with either one removed.
        // Good defence in depth, but do not credit it with pinning `approve`'s own check.
        it('refuses another user answering the gate, and leaves the action untaken', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            const other = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

            const response = await other.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: true })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            // Waited on before reading the flow. A refused approval starts no run, so the row is
            // already IDLE and this returns at once — but if the refusal ever regressed, the delete
            // would happen in a background loop and an immediate read would race past it and pass.
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)
            expect(await db.findOneBy('flow', { id: flow.id }), 'someone else approved the delete').not.toBeNull()
        })

        // The read surface is guarded once, not twice, and it now returns the model's real arguments
        // — a flow id, a table id, whatever `ap_run_action` was about to send. So a foreign reader
        // would learn what another user is doing in their own project, not merely that a gate exists.
        it('does not show another user the pending gate or its arguments', async () => {
            const flow = await createFlow()
            const { conversationId } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            const other = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

            const response = await other.get(`/v1/chat/conversations/${conversationId}/pending-gate`)

            // 404 rather than 403, matching `getOneOrThrow`'s deliberate non-disclosure: a foreign
            // conversation and a missing one must be indistinguishable.
            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            expect(response?.body ?? '', 'the flow id leaked to a user who does not own the conversation').not.toContain(flow.id)
        })

        // Single-use. The resumed run executes the tool itself, so a replayable approval is a
        // replayable destructive tool call. `ap_manage_fields` is used rather than a delete because
        // adding a field is *countable*: a second execution leaves a second row, which a delete
        // running twice would not.
        it('refuses a second answer to the same gate, and the tool ran exactly once', async () => {
            const table = await createTable()
            const { conversationId, gate } = await raiseGate({
                toolName: 'ap_manage_fields',
                args: { tableId: table.id, operation: 'ADD', name: 'Approved column', type: FieldType.TEXT },
                // Empty on purpose, and this is what makes the guard load-bearing rather than
                // decorative. A resume reply with text is persisted as an assistant message, so the
                // gate's tool message is no longer last and `collectToolApprovals` — which reads only
                // `messages.at(-1)` — would decline to execute anything a second time all by itself.
                // An empty reply produces a message with no parts, which the replay drops, leaving the
                // gate's tool message last again. Removing the single-use check below then really does
                // run the tool twice; with a chatty reply it would not, and the test would pass
                // whether the check existed or not.
                resumeReply: '',
            })

            const first = await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: true })
            expect(first?.statusCode).toBe(StatusCodes.OK)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const replay = await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: true })
            expect(replay?.statusCode).toBeGreaterThanOrEqual(StatusCodes.BAD_REQUEST)
            expect(replay?.statusCode).toBeLessThan(StatusCodes.INTERNAL_SERVER_ERROR)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const fields = await db.find('field', { tableId: table.id, name: 'Approved column' })
            expect(fields.length, 'the approved tool executed more than once').toBe(1)
        })

        // The `toolCallId` in the body is compared and never used to select the call. Two gated calls
        // sit in one step here, so naming the other one's id has to be refused rather than quietly
        // applied to whichever gate the approval id resolves to.
        it('refuses an answer that names a different tool call than the gate it addresses', async () => {
            await enableChatProvider(ctx.platform.id)
            const [first, second] = [await createFlow(), await createFlow()]
            const conversationId = await createConversation(ctx)
            scriptedResponses = [
                twoToolCallStream([
                    { toolName: 'ap_delete_flow', callId: 'call_1', args: JSON.stringify({ flowId: first.id }) },
                    { toolName: 'ap_delete_flow', callId: 'call_2', args: JSON.stringify({ flowId: second.id }) },
                ]),
                completionStream('Done.'),
            ]
            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'delete both', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const parts = await readParts(conversationId)
            const requests = parts.flatMap((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST ? [part] : [])
            expect(requests.map((part) => part.toolCallId), 'the step did not produce two gates, so this case tests nothing').toEqual(['call_1', 'call_2'])

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${requests[0].approvalId}`, {
                approved: true,
                toolCallId: 'call_2',
            })

            expect(response?.statusCode).toBeGreaterThanOrEqual(StatusCodes.BAD_REQUEST)
            expect(response?.statusCode).toBeLessThan(StatusCodes.INTERNAL_SERVER_ERROR)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)
            expect(await db.findOneBy('flow', { id: second.id }), 'the call named in the body was executed').not.toBeNull()
            expect(await db.findOneBy('flow', { id: first.id }), 'the gate that was addressed was executed anyway').not.toBeNull()
        })

        // Approving actually runs it. Without the resume run the gate is a dead end: 13 tools the
        // model can reach and no way for a human to say yes.
        it('approving executes the gated call and closes the gate', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            const bodiesBeforeResume = providerBodies.length

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: true })
            expect(response?.statusCode).toBe(StatusCodes.OK)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            expect(await db.findOneBy('flow', { id: flow.id }), 'the approved delete never ran').toBeNull()
            expect(await readPendingGate(conversationId)).toBeNull()

            // What the model is sent on resume. The SDK executes the approved call before the first
            // provider round-trip, so the result must arrive as an ordinary tool message — and the
            // `tool-approval-*` parts must not, because no provider has a wire shape for them.
            const resumeBody = providerBodies[bodiesBeforeResume]
            const resumeMessages = resumeBody['messages'] as { role: string, content?: unknown, tool_call_id?: string }[]
            const toolMessages = resumeMessages.filter((message) => message.role === 'tool')
            expect(toolMessages.length, 'the resume run sent the model no tool result for the call it just executed').toBeGreaterThan(0)
            expect(toolMessages.some((message) => message.tool_call_id === 'call_1')).toBe(true)
            expect(JSON.stringify(resumeBody), 'an approval part reached the provider').not.toContain('tool-approval-')
        })

        // Denying has to reach the model as a readable result, not as silence: the run resumes either
        // way, and a model that is told nothing will report the action as done.
        it('denying leaves the action untaken and tells the model why', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            const bodiesBeforeResume = providerBodies.length

            await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, {
                approved: false,
                reason: 'I still need that flow.',
            })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            expect(await db.findOneBy('flow', { id: flow.id }), 'a denied delete ran anyway').not.toBeNull()
            expect(JSON.stringify(providerBodies[bodiesBeforeResume])).toContain('I still need that flow.')

            const parts = await readParts(conversationId)
            expect(parts.filter((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE)).toEqual([
                expect.objectContaining({ approvalId: gate.gateId, approved: false, reason: 'I still need that flow.' }),
            ])
        })
    })

    describe('a gate the user walked away from', () => {
        // The abandoned gate. The user ignores the card and simply types again; the gate must be
        // closed by that, or it keeps being offered on every reload and an approval clicked later
        // resumes a run in which `collectToolApprovals` no longer reads the response at all — so the
        // tool silently never runs and the model is never told why.
        it('is denied when the next message is admitted, and the next run completes', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            scriptedResponses = [completionStream('Sure, something else then.')]

            const response = await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'never mind, list my flows', runId: apId() })
            expect(response?.statusCode).toBe(StatusCodes.OK)
            const row = await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            expect(row['status'], 'the run that followed the abandoned gate failed').toBe(ChatConversationStatus.IDLE)
            expect(await readPendingGate(conversationId), 'the abandoned gate is still waiting').toBeNull()
            expect(await db.findOneBy('flow', { id: flow.id })).not.toBeNull()

            const parts = await readParts(conversationId)
            expect(parts.filter((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE)).toEqual([
                expect.objectContaining({ approvalId: gate.gateId, approved: false }),
            ])
        })

        it('can no longer be approved after the user moved on', async () => {
            const flow = await createFlow()
            const { conversationId, gate } = await raiseGate({ toolName: 'ap_delete_flow', args: { flowId: flow.id } })
            scriptedResponses = [completionStream('Sure, something else then.')]
            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'never mind', runId: apId() })
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)

            const late = await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gate.gateId}`, { approved: true })

            expect(late?.statusCode).toBeGreaterThanOrEqual(StatusCodes.BAD_REQUEST)
            expect(late?.statusCode).toBeLessThan(StatusCodes.INTERNAL_SERVER_ERROR)
            await waitForStatus(conversationId, ChatConversationStatus.IDLE)
            expect(await db.findOneBy('flow', { id: flow.id }), 'a stale gate was still spendable').not.toBeNull()
        })
    })
})

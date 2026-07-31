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
    FlowVersionState,
    isNil,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
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
    })
})

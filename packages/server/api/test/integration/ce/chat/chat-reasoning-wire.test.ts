/**
 * #566 — the chat's reasoning opt-in, pinned on the wire.
 *
 * The "off" half was written and run BEFORE `chat-agent.service.ts` was touched: each provider's
 * request, as the pre-#566 code sent it, is the file snapshot under `__snapshots__/wire/`. Those
 * files are the golden bytes. A row without the setting and a row with `enabled: false` must both
 * still produce them exactly, or turning the feature off is not the same as never having had it.
 *
 * The provider SDKs are the real ones. Only the transport is replaced: every provider call goes
 * through `safeHttp.fetch` (`chatAiUtils.createChatModel` hands it to each factory), so spying on
 * it sees exactly the method, URL, headers and body the SDK built. Two inputs are held fixed so the
 * snapshots pin what this change could touch rather than every edit anyone makes to the prompt or
 * the MCP tools: the tool set is replaced by one small tool, and the system prompt text is swapped
 * for a placeholder after capture (by exact string, so every other byte stays as sent).
 */
import { safeHttp } from '@aiqadam/server-utils'
import {
    AIProviderModelType,
    AIProviderName,
    apId,
    ChatConversationStatus,
    isNil,
    PersistedChatPartType,
    PersistedChatRole,
} from '@aiqadam/shared'
import { dynamicTool } from 'ai'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { modelsCache } from '../../../../src/app/ai/models-cache'
import { buildSystemPrompt } from '../../../../src/app/chat/chat-agent.service'
import { chatTools } from '../../../../src/app/chat/chat-tools'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { db } from '../../../helpers/db'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

const ROW_UPDATED = '2026-09-29T00:00:00.000Z'
const SYSTEM_PROMPT_PLACEHOLDER = '<SYSTEM_PROMPT>'
// Headers that differ between two identical requests (SigV4's clock and signature) or between two
// machines (the SDK's user agent carries the Node version), so they cannot be golden bytes.
const UNSTABLE_HEADERS = new Set(['user-agent', 'authorization', 'x-amz-date'])

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger

// Read by the SDK factories as fallbacks, so an operator's shell (or this repo's CI runner) would
// otherwise decide the URL or the auth scheme the goldens record: `ANTHROPIC_BASE_URL` replaces
// `https://api.anthropic.com/v1`, and either AWS variable adds or swaps Bedrock's credentials.
const PROVIDER_ENV_FALLBACKS = ['ANTHROPIC_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SESSION_TOKEN']
const savedEnv = Object.fromEntries(PROVIDER_ENV_FALLBACKS.map((name) => [name, process.env[name]]))

let captured: CapturedRequest[] = []
let replies: Array<() => Response> = []

beforeAll(async () => {
    for (const name of PROVIDER_ENV_FALLBACKS) {
        delete process.env[name]
    }
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
    for (const [name, value] of Object.entries(savedEnv)) {
        if (!isNil(value)) {
            process.env[name] = value
        }
    }
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
    captured = []
    replies = []
    modelsCache.clear()
    vi.spyOn(chatTools, 'build').mockResolvedValue({
        ap_list_flows: dynamicTool({
            description: 'List the flows in the project.',
            inputSchema: z.object({ limit: z.number().optional() }),
            execute: async () => ({ flows: [] }),
        }),
        ap_delete_flow: dynamicTool({
            description: 'Delete a flow.',
            inputSchema: z.object({ flowId: z.string() }),
            needsApproval: true,
            execute: async () => ({ deleted: true }),
        }),
    })
    vi.spyOn(safeHttp, 'fetch').mockImplementation(async (input, init) => {
        captured.push({
            method: init?.method ?? 'GET',
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === 'string' ? init.body : '',
        })
        const reply = replies.shift()
        if (isNil(reply)) {
            throw new Error('the provider was called more often than the test scripted')
        }
        return reply()
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('Chat reasoning on the wire (#566)', () => {
    describe('off: the request is byte-identical to the one sent before the setting existed', () => {
        it.each(PROVIDER_CASES)('$provider with the setting absent', async (providerCase) => {
            await runOneTurn({ providerCase, reasoning: undefined })

            await expect(await renderRequest(captured[0])).toMatchFileSnapshot(`./__snapshots__/wire/${providerCase.provider}.txt`)
        })

        it.each(PROVIDER_CASES)('$provider with the setting disabled', async (providerCase) => {
            await runOneTurn({ providerCase, reasoning: { enabled: false, budgetTokens: 8_000 } })

            await expect(await renderRequest(captured[0])).toMatchFileSnapshot(`./__snapshots__/wire/${providerCase.provider}.txt`)
        })
    })

    describe('on', () => {
        const reasoning = { enabled: true, budgetTokens: 4_096 }

        // The acceptance case: an Anthropic-shaped stream carrying thinking deltas, through the real
        // `@ai-sdk/anthropic` model, persisted as REASONING and absent from the next turn's request.
        it('asks Claude 4.5 for budgeted thinking, persists what it streamed, and never sends it back', async () => {
            const anthropic = providerCaseFor(AIProviderName.ANTHROPIC)
            await enableProvider({ providerCase: anthropic, reasoning })
            const conversationId = await createConversation()
            const thinking = 'The user wants their flows; nothing to call yet.'
            replies = [anthropicReply({ thinking, signature: 'signature-turn-1', text: 'You have no flows yet.' })]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
            const afterFirst = await waitForSettled(conversationId)

            const firstBody = JSON.parse(captured[0].body)
            expect(firstBody.thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
            // The SDK adds the budget to the model's own 64,000 and clamps back to it, which is why
            // the schema's ceiling has to stay below every model's output limit.
            expect(firstBody.max_tokens).toBe(64_000)
            expect(afterFirst.status).toBe(ChatConversationStatus.IDLE)
            expect(afterFirst.uiMessages).toMatchObject([{ role: PersistedChatRole.USER }, { role: PersistedChatRole.ASSISTANT, parts: [
                { type: PersistedChatPartType.REASONING, text: thinking },
                { type: PersistedChatPartType.TEXT, text: 'You have no flows yet.' },
            ] }])

            replies = [anthropicReply({ text: 'Still none.' })]
            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'and now?', runId: apId() })
            await waitForSettled(conversationId)

            const secondBody = JSON.parse(captured[1].body)
            expect(JSON.stringify(secondBody.messages)).toContain('You have no flows yet.')
            expect(JSON.stringify(secondBody.messages)).not.toContain(thinking)
            expect(JSON.stringify(secondBody.messages)).not.toContain('signature-turn-1')
            expect(JSON.stringify(secondBody.messages)).not.toContain('"thinking"')
            // A new turn, so it is asked to think again.
            expect(secondBody.thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
        })

        // Within one `streamText` call the SDK replays the step's own thinking block, signature
        // intact, ahead of the tool call it led to — what Anthropic requires in a tool loop.
        it('replays the thinking block, signature intact, to the next step of the same run', async () => {
            const anthropic = providerCaseFor(AIProviderName.ANTHROPIC)
            await enableProvider({ providerCase: anthropic, reasoning })
            const conversationId = await createConversation()
            replies = [
                anthropicToolUse({ thinking: 'I should list them first.', signature: 'signature-step-1', toolName: 'ap_list_flows', toolUseId: 'toolu_1' }),
                anthropicReply({ text: 'You have no flows yet.' }),
            ]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
            await waitForSettled(conversationId)

            expect(captured).toHaveLength(2)
            const secondStep = JSON.parse(captured[1].body)
            const assistantTurn = secondStep.messages.find((message: { role: string }) => message.role === 'assistant')
            expect(assistantTurn.content[0]).toEqual({ type: 'thinking', thinking: 'I should list them first.', signature: 'signature-step-1' })
            expect(secondStep.thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
        })

        it('asks Claude 4.7 for adaptive thinking with its summary shown, and sends no budget', async () => {
            const anthropic = { ...providerCaseFor(AIProviderName.ANTHROPIC), modelId: 'claude-opus-4-7' }
            await enableProvider({ providerCase: anthropic, reasoning })
            const conversationId = await createConversation()
            replies = [anthropicReply({ text: 'You have no flows yet.' })]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
            await waitForSettled(conversationId)

            expect(JSON.parse(captured[0].body).thinking).toEqual({ type: 'adaptive', display: 'summarized' })
        })

        it('asks Bedrock through reasoningConfig, which the SDK sends as the Anthropic thinking field', async () => {
            await runOneTurn({ providerCase: providerCaseFor(AIProviderName.BEDROCK), reasoning })

            const body = JSON.parse(captured[0].body)
            expect(body.additionalModelRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: 4_096 } })
            expect(body.inferenceConfig).toEqual({ maxTokens: 4_096 + 4_096 })
        })

        it('asks OpenRouter through its own reasoning parameter, and nothing else', async () => {
            await runOneTurn({ providerCase: providerCaseFor(AIProviderName.OPENROUTER), reasoning })

            const body = JSON.parse(captured[0].body)
            expect(body.reasoning).toEqual({ max_tokens: 4_096 })
            // The pre-#566 helper added prompt caching here too; that is not part of reasoning.
            expect(body).not.toHaveProperty('cache_control')
        })

        it('asks Gemini to include its thoughts', async () => {
            await runOneTurn({ providerCase: providerCaseFor(AIProviderName.GOOGLE), reasoning })

            expect(JSON.parse(captured[0].body).generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } })
        })

        // The run resumed from an approval continues the turn the gate interrupted, and its replay of
        // that turn's `tool_use` has no thinking block in front of it. Chosen behaviour: that one run
        // is not asked to reason, so its request is the one this path sent before #566.
        it('does not ask the run resumed from a tool approval to reason', async () => {
            const anthropic = providerCaseFor(AIProviderName.ANTHROPIC)
            await enableProvider({ providerCase: anthropic, reasoning })
            const conversationId = await createConversation()
            replies = [anthropicToolUse({ thinking: 'Deleting needs the user to agree.', signature: 'signature-gate', toolName: 'ap_delete_flow', toolUseId: 'toolu_gate', input: { flowId: 'flow-1' } })]

            await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'delete flow-1', runId: apId() })
            await waitForSettled(conversationId)
            expect(JSON.parse(captured[0].body).thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
            const gate = await ctx.get(`/v1/chat/conversations/${conversationId}/pending-gate`)
            const gateId: unknown = gate?.json()?.gateId
            if (typeof gateId !== 'string') {
                throw new Error('no gate was raised, so nothing below tests what it claims to')
            }

            replies = [anthropicReply({ text: 'Deleted.' })]
            await ctx.post(`/v1/chat/conversations/${conversationId}/tool-approvals/${gateId}`, { approved: true })
            const settled = await waitForSettled(conversationId)

            expect(captured).toHaveLength(2)
            const resumed = JSON.parse(captured[1].body)
            expect(resumed).not.toHaveProperty('thinking')
            expect(resumed.max_tokens).toBe(64_000)
            expect(JSON.stringify(resumed.messages)).toContain('toolu_gate')
            expect(JSON.stringify(resumed.messages)).not.toContain('signature-gate')
            expect(settled.status).toBe(ChatConversationStatus.IDLE)
        })
    })
})

async function runOneTurn({ providerCase, reasoning }: { providerCase: ProviderCase, reasoning: Record<string, unknown> | undefined }): Promise<string> {
    await enableProvider({ providerCase, reasoning })
    const conversationId = await createConversation()
    replies = [providerCase.reply]
    await ctx.post(`/v1/chat/conversations/${conversationId}/messages`, { content: 'list my flows', runId: apId() })
    await waitForSettled(conversationId)
    expect(captured).toHaveLength(1)
    return conversationId
}

async function enableProvider({ providerCase, reasoning }: { providerCase: ProviderCase, reasoning: Record<string, unknown> | undefined }): Promise<void> {
    const id = apId()
    await db.save('ai_provider', {
        id,
        created: ROW_UPDATED,
        updated: ROW_UPDATED,
        platformId: ctx.platform.id,
        provider: providerCase.provider,
        displayName: providerCase.provider,
        auth: await encryptUtils.encryptObject(providerCase.auth),
        config: { ...providerCase.config, ...(isNil(reasoning) ? {} : { reasoning }) },
        enabledForChat: true,
    })
    // None of these four providers stores a model catalogue, so resolving the chat model reads the
    // model list — seeded here under the key `aiProviderService.listModels` looks up, so the only
    // outbound request left is the completion itself.
    modelsCache.set({
        key: `${id}-${new Date(ROW_UPDATED).getTime()}`,
        models: [{ id: providerCase.modelId, name: providerCase.modelId, type: AIProviderModelType.TEXT }],
    })
}

async function createConversation(): Promise<string> {
    const response = await ctx.post('/v1/chat/conversations', {})
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response!.json().id
}

async function waitForSettled(conversationId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id: conversationId })
        if (row?.status === ChatConversationStatus.IDLE || row?.status === ChatConversationStatus.ERROR) {
            return row
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Conversation ${conversationId} never settled`)
}

async function renderRequest(request: CapturedRequest | undefined): Promise<string> {
    if (isNil(request)) {
        throw new Error('no provider request was captured')
    }
    const systemPrompt = await buildSystemPrompt({ projectId: ctx.project.id, platformId: ctx.platform.id, userId: ctx.user.id, log })
    const escapedPrompt = JSON.stringify(systemPrompt).slice(1, -1)
    if (!request.body.includes(escapedPrompt)) {
        throw new Error('the system prompt was not found verbatim in the body, so the placeholder would hide nothing and pin nothing')
    }
    const headers = Object.entries(request.headers)
        .filter(([name]) => !UNSTABLE_HEADERS.has(name))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}: ${value}`)
    return [
        `${request.method} ${request.url}`,
        ...headers,
        '',
        request.body.replaceAll(escapedPrompt, SYSTEM_PROMPT_PLACEHOLDER),
        '',
    ].join('\n')
}

function sse(events: Array<{ event?: string, data: Record<string, unknown> | string }>): () => Response {
    const text = events.map(({ event, data }) => `${isNil(event) ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('')
    return () => new Response(text, { status: StatusCodes.OK, headers: { 'content-type': 'text/event-stream' } })
}

function anthropicReply({ thinking, signature, text }: { thinking?: string, signature?: string, text: string }): () => Response {
    const thinkingEvents = isNil(thinking) ? [] : [
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature ?? 'sig' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    ]
    const textIndex = thinkingEvents.length === 0 ? 0 : 1
    return sse([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } },
        ...thinkingEvents,
        { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
    ])
}

function anthropicToolUse({ thinking, signature, toolName, toolUseId, input = {} }: { thinking: string, signature: string, toolName: string, toolUseId: string, input?: Record<string, unknown> }): () => Response {
    return sse([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
    ])
}

function googleReply(text: string): () => Response {
    return sse([{ data: {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
    } }])
}

function openRouterReply(text: string): () => Response {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> => ({
        id: 'gen-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'anthropic/claude-sonnet-4.5',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    })
    return sse([
        { data: chunk({ role: 'assistant', content: text }, null) },
        { data: chunk({}, 'stop') },
        { data: '[DONE]' },
    ])
}

// Bedrock streams AWS's binary event-stream framing, which this package has no encoder for. Only
// the request is under test for Bedrock, so the reply is a refusal the SDK does not retry.
function bedrockRefusal(): () => Response {
    return () => new Response(JSON.stringify({ message: 'scripted refusal' }), { status: StatusCodes.BAD_REQUEST, headers: { 'content-type': 'application/json' } })
}

const PROVIDER_CASES: ProviderCase[] = [
    {
        provider: AIProviderName.ANTHROPIC,
        modelId: 'claude-sonnet-4-5-20250929',
        auth: { apiKey: 'sk-ant-test' },
        config: {},
        reply: anthropicReply({ text: 'You have no flows yet.' }),
    },
    {
        provider: AIProviderName.BEDROCK,
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        auth: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret' },
        config: { region: 'us-east-1' },
        reply: bedrockRefusal(),
    },
    {
        provider: AIProviderName.OPENROUTER,
        modelId: 'anthropic/claude-sonnet-4.5',
        auth: { apiKey: 'sk-or-test' },
        config: {},
        reply: openRouterReply('You have no flows yet.'),
    },
    {
        provider: AIProviderName.GOOGLE,
        modelId: 'gemini-2.5-flash',
        auth: { apiKey: 'google-test-key' },
        config: {},
        reply: googleReply('You have no flows yet.'),
    },
]

function providerCaseFor(provider: AIProviderName): ProviderCase {
    const found = PROVIDER_CASES.find((providerCase) => providerCase.provider === provider)
    if (isNil(found)) {
        throw new Error(`no case for ${provider}`)
    }
    return found
}

type ProviderCase = {
    provider: AIProviderName
    modelId: string
    auth: Record<string, string>
    config: Record<string, unknown>
    reply: () => Response
}

type CapturedRequest = {
    method: string
    url: string
    headers: Record<string, string>
    body: string
}

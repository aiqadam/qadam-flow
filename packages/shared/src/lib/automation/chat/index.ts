import { z } from 'zod'
import { BaseModelSchema, isObject, Nullable } from '../../core/common'
import { formErrors } from '../../form-errors'
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from '../../management/ai-providers'

const MAX_FILE_BINARY_SIZE = 10 * 1024 * 1024
const MAX_FILE_BASE64_CHARS = Math.ceil(MAX_FILE_BINARY_SIZE * 4 / 3)

const CHAT_ALLOWED_MIME_TYPES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json',
    'application/pdf',
] as const

const SAFE_FILENAME = /^[^\x00-\x1f\r\n]*$/

const ChatMessageFile = z.object({
    name: z.string().min(1).max(255).refine(
        (v) => SAFE_FILENAME.test(v),
        { message: formErrors.invalidFileName },
    ),
    mimeType: z.enum(CHAT_ALLOWED_MIME_TYPES),
    data: z.string().max(MAX_FILE_BASE64_CHARS),
})

export enum PersistedChatPartType {
    TEXT = 'text',
    REASONING = 'reasoning',
    TOOL_CALL = 'tool-call',
    THINKING_STATUS = 'thinking-status',
    BATCH_PROGRESS = 'batch-progress',
    ACTION_RECEIPT = 'action-receipt',
    TOOL_APPROVAL_REQUEST = 'tool-approval-request',
    TOOL_APPROVAL_RESPONSE = 'tool-approval-response',
}

export enum PersistedToolCallStatus {
    COMPLETED = 'completed',
    ERROR = 'error',
}

export enum PersistedChatRole {
    USER = 'user',
    ASSISTANT = 'assistant',
}

const PersistedTextPartSchema = z.object({
    type: z.literal(PersistedChatPartType.TEXT),
    text: z.string(),
})

const PersistedReasoningPartSchema = z.object({
    type: z.literal(PersistedChatPartType.REASONING),
    text: z.string(),
})

const PersistedToolCallPartSchema = z.object({
    type: z.literal(PersistedChatPartType.TOOL_CALL),
    toolCallId: z.string(),
    toolName: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().optional(),
    status: z.enum([PersistedToolCallStatus.COMPLETED, PersistedToolCallStatus.ERROR]),
    errorText: z.string().optional(),
})

const PersistedThinkingStatusPartSchema = z.object({
    type: z.literal(PersistedChatPartType.THINKING_STATUS),
    text: z.string(),
})

const PersistedBatchProgressPartSchema = z.object({
    type: z.literal(PersistedChatPartType.BATCH_PROGRESS),
    data: z.record(z.string(), z.unknown()),
})

const PersistedActionReceiptPartSchema = z.object({
    type: z.literal(PersistedChatPartType.ACTION_RECEIPT),
    toolCallId: z.string(),
    actionDisplayName: z.string(),
    qadamName: z.string(),
    connectionLabel: z.string().optional(),
    status: z.enum(['success', 'failed']),
    output: z.unknown().optional(),
    errorMessage: z.string().optional(),
    timestamp: z.string(),
})

// A gated tool call produces no result, so it cannot be stored as a tool call: a result-less call
// replays to the model as a failure, and the model then apologises or retries instead of waiting
// for the human. The pending gate is stored as itself, and carries everything the resumed run needs
// to rebuild the tool call the SDK looks up by `toolCallId` when the approval is answered.
const PersistedToolApprovalRequestPartSchema = z.object({
    type: z.literal(PersistedChatPartType.TOOL_APPROVAL_REQUEST),
    approvalId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
})

const PersistedToolApprovalResponsePartSchema = z.object({
    type: z.literal(PersistedChatPartType.TOOL_APPROVAL_RESPONSE),
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
})

const PersistedChatPartSchema = z.discriminatedUnion('type', [
    PersistedTextPartSchema,
    PersistedReasoningPartSchema,
    PersistedToolCallPartSchema,
    PersistedThinkingStatusPartSchema,
    PersistedBatchProgressPartSchema,
    PersistedActionReceiptPartSchema,
    PersistedToolApprovalRequestPartSchema,
    PersistedToolApprovalResponsePartSchema,
])

const TokenCount = z.int().nonnegative()

// How full the model's context was when it wrote this reply, as the chat's Context popover shows
// it. `usedTokens` is the provider's own count, not an estimate: the last step's input plus the
// reply text, which is what the next turn sends back. The breakdown is an estimate — each part's
// share of the characters sent, scaled so the parts add up to `usedTokens` exactly.
export const ChatContextUsageSchema = z.object({
    modelId: z.string(),
    usedTokens: TokenCount,
    // Null when neither the provider's model list nor the operator says; readers then assume
    // `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS` and say so.
    contextWindowTokens: z.int().positive().nullable(),
    // Where the measured transcript began in `uiMessages`. A compaction pass that moves the boundary
    // past it makes this measurement stale until the next reply, and the popover says so.
    transcriptStartIndex: z.int().nonnegative().optional(),
    breakdown: z.object({
        systemPrompt: TokenCount,
        tools: TokenCount,
        toolCount: TokenCount,
        messages: TokenCount,
        toolOutputs: TokenCount,
        // Optional because replies measured before compaction existed carry none.
        summary: TokenCount.optional(),
    }),
})
export type ChatContextUsage = z.infer<typeof ChatContextUsageSchema>

export const PersistedChatMessageSchema = z.object({
    role: z.enum([PersistedChatRole.USER, PersistedChatRole.ASSISTANT]),
    parts: z.array(PersistedChatPartSchema),
    thinkingDurationMs: z.number().optional(),
    contextUsage: ChatContextUsageSchema.optional(),
})

export type PersistedTextPart = z.infer<typeof PersistedTextPartSchema>
export type PersistedReasoningPart = z.infer<typeof PersistedReasoningPartSchema>
export type PersistedToolCallPart = z.infer<typeof PersistedToolCallPartSchema>
export type PersistedThinkingStatusPart = z.infer<typeof PersistedThinkingStatusPartSchema>
export type PersistedActionReceiptPart = z.infer<typeof PersistedActionReceiptPartSchema>
export type PersistedToolApprovalRequestPart = z.infer<typeof PersistedToolApprovalRequestPartSchema>
export type PersistedToolApprovalResponsePart = z.infer<typeof PersistedToolApprovalResponsePartSchema>
export type PersistedChatPart = z.infer<typeof PersistedChatPartSchema>
export type PersistedChatMessage = z.infer<typeof PersistedChatMessageSchema>

export enum ChatConversationStatus {
    IDLE = 'IDLE',
    STREAMING = 'STREAMING',
    ERROR = 'ERROR',
}

export const ChatConversation = z.object({
    ...BaseModelSchema,
    platformId: z.string(),
    projectId: Nullable(z.string()),
    userId: z.string(),
    title: Nullable(z.string()),
    modelName: Nullable(z.string()),
    status: z.nativeEnum(ChatConversationStatus).default(ChatConversationStatus.IDLE),
    messages: z.array(z.record(z.string(), z.unknown())).default([]),
    uiMessages: z.array(PersistedChatMessageSchema).nullable().default(null),
    summary: Nullable(z.string()),
    summarizedUpToIndex: Nullable(z.number().int()),
    // Whether messages leaving the transcript are summarised (true) or dropped (false). Per
    // conversation, so a user who distrusts the summary for one thread can turn it off there.
    autoCompact: z.boolean().default(true),
})
export type ChatConversation = z.infer<typeof ChatConversation>

export const CreateChatConversationRequest = z.object({
    title: Nullable(z.string()).optional(),
    modelName: Nullable(z.string()).optional(),
    // Null or absent lets the first run pick the default project; either way the project is pinned
    // on that first run and cannot change afterwards.
    projectId: Nullable(z.string()).optional(),
})
export type CreateChatConversationRequest = z.infer<typeof CreateChatConversationRequest>

export const UpdateChatConversationRequest = z.object({
    title: Nullable(z.string()).optional(),
    modelName: Nullable(z.string()).optional(),
    // Not nullable, unlike on create: clearing the pick would let a run that already resolved the
    // old project pin it anyway, because `admitRun` cannot tell a cleared row from a fresh one.
    projectId: z.string().optional(),
    autoCompact: z.boolean().optional(),
})
export type UpdateChatConversationRequest = z.infer<typeof UpdateChatConversationRequest>

export const SendChatMessageRequest = z.object({
    content: z.string().max(51200),
    runId: z.string().optional(),
    files: z.array(ChatMessageFile).max(10).optional(),
}).refine(
    (val) => val.content.length > 0 || (val.files && val.files.length > 0),
    { message: formErrors.messageRequiresContentOrFiles },
)
export type SendChatMessageRequest = z.infer<typeof SendChatMessageRequest>

// Deliberately only these two fields. The web client used to post a free-form `payload` alongside
// them and the route validated no body at all, so an authorization endpoint accepted arbitrary
// unvalidated JSON — and nothing on the server ever read it. The gated call's arguments come from
// the persisted request part, never from whoever answers the gate; a body that could restate them
// would let the person approving "Delete flow A" have flow B deleted instead.
export const AnswerChatToolApprovalRequest = z.object({
    approved: z.boolean(),
    reason: z.string().max(500).optional(),
    // Optional, and only ever compared — never used to select the call. A client that shows a card
    // knows which call it drew, so a mismatch means the card and the transcript have diverged and
    // the answer must not be applied to whatever the gate happens to point at now.
    toolCallId: z.string().optional(),
})
export type AnswerChatToolApprovalRequest = z.infer<typeof AnswerChatToolApprovalRequest>

export type PendingChatToolApproval = {
    gateId: string
    toolCallId: string
    toolName: string
    displayName: string
    toolInput: Record<string, unknown>
}

export type ChatHistoryToolCall = {
    toolCallId: string
    title: string
    status: string
    input?: Record<string, unknown>
    output?: string
}

export type ChatHistoryMessage = {
    role: 'user' | 'assistant'
    content: string
    toolCalls?: ChatHistoryToolCall[]
    thoughts?: string
}

export type PlanStepStatus = 'pending' | 'executing' | 'done' | 'error'

export type PlanStepUpdate = {
    stepIndex: number
    status: PlanStepStatus
}

export type ChatToolOutputs = {
    ap_set_session_title: { success: boolean }
    ap_select_project: { success: boolean, message?: string, error?: string }
    ap_request_plan_approval: { success: boolean, message: string }
    ap_list_across_projects: { content: { type: string, text: string }[] }
    ap_execute_action:
    | { noAuthRequired: true, piece: string }
    | { needsConnection: true, piece: string, displayName: string }
    | { pickConnection: true, piece: string, displayName: string, connections: ConnectionOption[] }
    | { success: boolean, error?: string, output?: unknown, batchProgress?: BatchProgressData }
    ap_show_connection_required: { displayed: boolean }
    ap_show_connection_picker: { displayed: boolean }
    ap_show_project_picker: { displayed: boolean }
    ap_show_questions: { displayed: boolean }
    ap_show_quick_replies: { displayed: boolean }
    ap_update_thinking_status: { success: boolean }
}

export type ConnectionOption = {
    label: string
    project: string
    externalId: string
    projectId: string
    status: string
}

export type ChatToolName = keyof ChatToolOutputs

function unwrapToolOutput(output: unknown): unknown {
    if (typeof output !== 'object' || output === null) return output
    if (!('type' in output) || !('value' in output)) return output
    const record = output as Record<string, unknown>
    if (record['type'] === 'json') {
        return record['value']
    }
    return output
}

export const chatPersistenceUtils = {
    unwrapToolOutput,
}

// Where the transcript a run sends begins. Everything before `summarizedUpToIndex` has left the
// transcript: folded into the conversation's `summary` by a compaction pass, or — with auto-compact
// off, or for conversations that predate compaction — simply dropped. The rest is replayed verbatim.
// It lives here rather than in the server because the chat UI draws the same boundary, and a second
// copy would let the two drift apart silently.
//
// The start is moved forward to a user turn, or the transcript could open with an assistant message
// answering a question the model can no longer see — the one shape a provider rejects outright. The
// whole message is the unit, so an assistant turn is never split from the tool results that answer
// its calls. Typed structurally so the server's persisted messages and the browser's UI messages both
// go through it.
function transcriptStart({ messages, summarizedUpToIndex }: { messages: readonly ReplayableChatMessage[], summarizedUpToIndex: number | null }): number {
    const from = Math.min(Math.max(summarizedUpToIndex ?? 0, 0), messages.length)
    if (from === 0) {
        return 0
    }
    const firstReplayableTurn = messages.slice(from).findIndex(isReplayableUserTurn)
    return firstReplayableTurn <= 0 ? from : from + firstReplayableTurn
}

// The first user turn that actually produces a message, not merely the first user turn: a
// files-only message is persisted with empty text and the transcript drops it. Mirrors the join in
// the server's `toUserModelMessages`, so both sides agree on which turn that is.
function isReplayableUserTurn(message: ReplayableChatMessage): boolean {
    if (message.role !== PersistedChatRole.USER) {
        return false
    }
    const text = message.parts
        .flatMap((part) => part.type === PersistedChatPartType.TEXT ? [part.text ?? ''] : [])
        .join('\n')
    return text.length > 0
}

// The token budget a measured reply implies (#567). The system prompt and the tool schemas are sent
// on every turn whatever happens to the history, so the thresholds are fractions of the room left
// after them — against the whole window, a 64k model would compact at 38k of which 23k can never be
// freed. Shared so that when the server compacts and what the Context popover says it will are the
// same number.
function contextBudget(usage: ChatContextUsage): ChatContextBudget {
    const windowTokens = usage.contextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
    const fixedTokens = usage.breakdown.systemPrompt + usage.breakdown.tools
    const roomTokens = Math.max(0, windowTokens - fixedTokens)
    return {
        windowTokens,
        fixedTokens,
        conversationTokens: Math.max(0, usage.usedTokens - fixedTokens),
        compactAtTokens: fixedTokens + Math.round(roomTokens * CHAT_COMPACT_AT_RATIO),
        keepTokens: Math.round(roomTokens * CHAT_COMPACTION_KEEP_RATIO),
    }
}

function isCompactionDue(usage: ChatContextUsage): boolean {
    return usage.usedTokens > contextBudget(usage).compactAtTokens
}

// Not later than 60%: compaction runs after the reply, and the next run grows the prompt with every
// tool round it makes (up to 25) before it could run again. Every step also re-sends the whole
// transcript, so a fuller context is paid for many times over, and models degrade on long contexts.
export const CHAT_COMPACT_AT_RATIO = 0.6
// How much of the room the history kept verbatim may take after a pass: enough for the current
// thread of work, and far enough under the trigger that a pass buys several turns.
export const CHAT_COMPACTION_KEEP_RATIO = 0.25

export const chatContextUtils = {
    transcriptStart,
    isReplayableUserTurn,
    contextBudget,
    isCompactionDue,
}

function isBatchItemResult(value: unknown): value is BatchItemResult {
    if (!isObject(value)) return false
    if (typeof value['index'] !== 'number' || typeof value['success'] !== 'boolean') return false
    if (value['error'] !== undefined && typeof value['error'] !== 'string') return false
    return true
}

function isBatchProgressData(value: unknown): value is BatchProgressData {
    if (!isObject(value)) return false
    return typeof value['label'] === 'string'
        && typeof value['total'] === 'number'
        && typeof value['completed'] === 'number'
        && typeof value['succeeded'] === 'number'
        && typeof value['failed'] === 'number'
        && typeof value['done'] === 'boolean'
        && Array.isArray(value['results'])
        && value['results'].every(isBatchItemResult)
}

export type BatchItemResult = {
    index: number
    success: boolean
    output?: unknown
    error?: string
}

export type BatchProgressData = {
    label: string
    total: number
    completed: number
    succeeded: number
    failed: number
    done: boolean
    results: BatchItemResult[]
}

export { isBatchProgressData }

export type ChatAllowedMimeType = typeof CHAT_ALLOWED_MIME_TYPES[number]
export { CHAT_ALLOWED_MIME_TYPES }

// A live run touches its conversation row at every step, so a STREAMING row untouched for this long
// belongs to a process that is no longer running — an API restart mid-run, which is routine on a
// self-hosted upgrade. Two processes act on the same number and neither can see the other's: the
// server stops honouring the row (`isAbandoned` in `chat-conversation.service.ts`) and the browser
// stops polling it (`use-chat.ts`). It has to be one literal rather than two, for the same reason
// the provider timeouts above do — `isAbandoned` is consulted only on the admission path, so
// `getConversation` keeps reporting STREAMING for a run nobody is running, and a browser copy that
// drifted above the server's would spin on that status forever.
export const ABANDONED_CHAT_RUN_AFTER_MS = 5 * 60 * 1000

export type ChatContextBudget = {
    windowTokens: number
    // The system prompt and the tool schemas: sent every turn, never compacted.
    fixedTokens: number
    // Everything else: the summary, the replayed messages and their tool outputs.
    conversationTokens: number
    // The used-token level past which the next reply triggers a compaction pass.
    compactAtTokens: number
    // Roughly how much history a pass keeps verbatim.
    keepTokens: number
}

export type ReplayableChatMessage = {
    role: string
    parts: ReadonlyArray<{ type: string, text?: string }>
}

import { readFile } from 'node:fs/promises'
import {
    ChatContextUsage,
    ChatContextUsageSchema,
    chatContextUtils,
    ChatConversation,
    DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    isNil,
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedChatRole,
    sanitizeObjectForPostgresql,
    tryCatch,
} from '@aiqadam/shared'
import { generateText } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { chatConversationService } from './chat-conversation.service'
import { ResolvedChatModel } from './chat-model'

/**
 * Keeps a long conversation inside the model's context window (#567) by moving the transcript's start
 * (`summarizedUpToIndex`) forward. With auto-compact on, what the start passes over is folded into the
 * conversation's `summary` by the conversation's own model; with it off, it is only dropped.
 *
 * The new summary is written from the previous summary plus the messages leaving the transcript —
 * never from the messages that stay, which the model still gets verbatim — so every message is covered
 * exactly once and no pass ever re-reads the whole history.
 *
 * Neither entry point throws: a pass that fails leaves the conversation exactly as it was, and the next
 * reply tries again. Compaction is how a conversation stays affordable; it is never a reason for a turn
 * to fail.
 */
export const chatCompaction = (log: FastifyBaseLogger) => ({
    // After every reply, in the background. Due only when the reply's own measurement crossed the
    // threshold the Context popover shows (`chatContextUtils.isCompactionDue`).
    async compactAfterReply({ id, platformId, userId, resolvedModel }: CompactParams): Promise<void> {
        const { error } = await tryCatch(async () => {
            const conversation = await chatConversationService.getOneOrThrow({ id, platformId, userId })
            const uiMessages = conversation.uiMessages ?? []
            const usage = lastMeasurement(uiMessages)
            if (isNil(usage) || !chatContextUtils.isCompactionDue(usage)) {
                return
            }
            // A pass that landed after this reply was admitted has already moved the start past
            // where the measurement began; the figures describe a longer transcript than the next
            // turn will send, and the next reply's own measurement decides instead.
            const start = chatContextUtils.transcriptStart({ messages: uiMessages, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null })
            if (!isNil(usage.transcriptStartIndex) && usage.transcriptStartIndex < start) {
                return
            }
            await compact({
                conversation: toCompactionState(conversation),
                keepTokens: chatContextUtils.contextBudget(usage).keepTokens,
                tokensPerChar: chatCompactionPlan.tokensPerChar({ usage, uiMessages, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null }),
                resolvedModel,
                abortSignal: null,
                heartbeat: null,
                log,
            })
        })
        if (!isNil(error)) {
            log.warn({ conversationId: id, errorName: error.name }, '[chatCompaction#compactAfterReply] compaction failed; the conversation is unchanged and the next reply retries')
        }
    },

    /**
     * The safety net for a turn the provider refused as too long, whatever the measurements said —
     * the window size can be unknown or wrong. Keeps half of what a regular pass would, since the
     * estimate that let the conversation get here was evidently low. Returns whether the transcript
     * got shorter, which is the only case in which retrying the turn can help.
     *
     * Runs inside the turn, so it takes the run's abort signal — a Stop while it summarises stops it —
     * and a heartbeat called before each summariser call: a pass can take several, longer together
     * than `ABANDONED_CHAT_RUN_AFTER_MS`, and a run that stops beating is taken over as abandoned.
     */
    async compactForOverflow({ id, platformId, userId, resolvedModel, abortSignal, heartbeat }: CompactForOverflowParams): Promise<boolean> {
        const { data, error } = await tryCatch(async () => {
            const conversation = await chatConversationService.getOneOrThrow({ id, platformId, userId })
            const uiMessages = conversation.uiMessages ?? []
            const usage = lastMeasurement(uiMessages)
            const keepTokens = isNil(usage)
                ? Math.round((resolvedModel.contextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS) * CHAT_OVERFLOW_KEEP_RATIO)
                : Math.round(chatContextUtils.contextBudget(usage).keepTokens / 2)
            return compact({
                conversation: toCompactionState(conversation),
                keepTokens,
                tokensPerChar: isNil(usage) ? DEFAULT_TOKENS_PER_CHAR : chatCompactionPlan.tokensPerChar({ usage, uiMessages, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null }),
                resolvedModel,
                abortSignal,
                heartbeat,
                log,
            })
        })
        if (!isNil(error)) {
            log.warn({ conversationId: id, errorName: error.name }, '[chatCompaction#compactForOverflow] compaction failed; the turn fails as it would have without it')
            return false
        }
        return data ?? false
    },
})

// Pure, so the choice of boundary is tested without a model or a database.
export const chatCompactionPlan = {
    /**
     * The index the transcript should start at after a pass, or null when no pass can help.
     *
     * The newest messages are kept while their estimated size fits `keepTokens`, and the boundary is
     * then moved forward to a user turn (a transcript must open on one). The last exchange is always
     * kept, however large, since without it the model would not know what it was just asked.
     */
    cutIndex({ uiMessages, fromIndex, keepTokens, tokensPerChar: ratio }: CutIndexParams): number | null {
        const start = chatContextUtils.transcriptStart({ messages: uiMessages, summarizedUpToIndex: fromIndex })
        const userTurns = uiMessages
            .map((message, index) => ({ message, index }))
            .filter(({ message, index }) => index > start && chatContextUtils.isReplayableUserTurn(message))
            .map(({ index }) => index)
        const lastUserTurn = userTurns.at(-1)
        if (isNil(lastUserTurn)) {
            return null
        }
        const sizes = uiMessages.map((message) => messageChars(message) * ratio)
        const keptFrom = (index: number): number => sizes.slice(index).reduce(sum, 0)
        return userTurns.find((index) => keptFrom(index) <= keepTokens) ?? lastUserTurn
    },

    // Calibrates the character estimate against what the provider actually counted for the same
    // history, so the kept tail is sized in this model's tokens rather than a rule of thumb. "The same"
    // is the span the measurement was taken over: a pass that landed after the reply was admitted has
    // moved the row's start since, and dividing the old count by the new, shorter span would overstate
    // the ratio and fold far more than the kept share away. The summary's own share is taken out by its
    // estimated tokens, since the summary that was sent may have been replaced since.
    // A measurement from before the start was recorded falls back to the row's current start.
    tokensPerChar({ usage, uiMessages, summarizedUpToIndex }: TokensPerCharParams): number {
        const measuredFrom = usage.transcriptStartIndex ?? chatContextUtils.transcriptStart({ messages: uiMessages, summarizedUpToIndex })
        const characters = uiMessages.slice(measuredFrom).map(messageChars).reduce(sum, 0)
        const tokens = chatContextUtils.contextBudget(usage).conversationTokens - (usage.breakdown.summary ?? 0)
        if (characters === 0 || tokens <= 0) {
            return DEFAULT_TOKENS_PER_CHAR
        }
        return Math.min(1, Math.max(0.05, tokens / characters))
    },

    // The characters one summariser call may carry, derived from the window it will be sent to.
    maxSummaryInputChars({ contextWindowTokens, tokensPerChar: ratio }: { contextWindowTokens: number | null, tokensPerChar: number }): number {
        const windowTokens = contextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
        return Math.max(MIN_SUMMARY_INPUT_CHARS, Math.floor((windowTokens * SUMMARY_INPUT_WINDOW_RATIO - MAX_SUMMARY_OUTPUT_TOKENS) / ratio))
    },

    /**
     * Splits the messages leaving the transcript, `[start, cut)`, into slices one summariser call
     * each can carry. Slices end where a user turn begins, so however many of them a pass gets
     * through, the start it moves to is one a transcript can open on. An exchange larger than a
     * whole slice is clipped to fit rather than skipped: its opening survives, which is where what
     * the user asked is.
     */
    summarySlices({ uiMessages, start, cut, maxInputChars }: SummarySlicesParams): SummarySlice[] {
        const exchanges = uiMessages
            .slice(start, cut)
            .reduce<Array<{ endIndex: number, rendered: string }>>((acc, message, offset) => {
                const index = start + offset
                const rendered = renderMessage(message)
                const last = acc.at(-1)
                if (isNil(last) || chatContextUtils.isReplayableUserTurn(message)) {
                    return [...acc, { endIndex: index + 1, rendered }]
                }
                return [...acc.slice(0, -1), { endIndex: index + 1, rendered: joinRendered([last.rendered, rendered]) }]
            }, [])
            .map((exchange) => ({ ...exchange, rendered: clip({ text: exchange.rendered, max: maxInputChars }) }))
        return exchanges.reduce<SummarySlice[]>((slices, exchange) => {
            const last = slices.at(-1)
            if (!isNil(last) && last.rendered.length + exchange.rendered.length + 1 <= maxInputChars) {
                return [...slices.slice(0, -1), { endIndex: exchange.endIndex, rendered: joinRendered([last.rendered, exchange.rendered]) }]
            }
            return [...slices, exchange]
        }, [])
    },
}

// 60% of the window would compact; after a refusal, keep a fifth of it.
const CHAT_OVERFLOW_KEEP_RATIO = 0.2
// The usual rule of thumb for English prose and JSON, used only when there is no measurement to
// calibrate against.
const DEFAULT_TOKENS_PER_CHAR = 0.25
// A floor for windows too small for the ratio to leave anything useful.
const MIN_SUMMARY_INPUT_CHARS = 4_000
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g
// Tool outputs are what make a build session long — a flow's JSON, a qadam's props. The summary needs
// what a call did and what came of it, not the payload, and an unbounded input would let the pass
// itself overflow the window it exists to protect.
const MAX_TOOL_INPUT_CHARS = 1_000
const MAX_TOOL_OUTPUT_CHARS = 2_000
const MAX_SUMMARY_OUTPUT_TOKENS = 2_000
const SUMMARY_TIMEOUT_MS = 90_000
// What one summariser call may be sent, as a share of the model's window. The messages leaving the
// transcript are the part of a conversation that no longer fits — on the overflow path, part of a
// request the provider just refused — so sending them in one call could be refused in turn, and the
// conversation would fail on every turn after. Past this share they are summarised in several calls,
// each folding its slice into the summary the previous one wrote.
const SUMMARY_INPUT_WINDOW_RATIO = 0.5
// Bounds what one pass can spend. A pass that needs more moves the start only as far as it got; the
// next pass carries on from there.
const MAX_SUMMARY_CALLS_PER_PASS = 4
// Written to the end of the summary when a pass with auto-compact off drops messages, so a summary
// sent again after auto-compact is turned back on does not read as covering everything up to the
// transcript's start.
const DROPPED_WITHOUT_SUMMARY_NOTE = '- Some later messages, after the points above, were dropped without being summarised while auto-compact was off; nothing is known about them.'
// Same relative-to-cwd form as the system prompt (`chat-agent.service.ts`, `SYSTEM_PROMPT_PATH`).
const COMPACTION_PROMPT_PATH = 'packages/server/api/src/assets/prompts/chat-compaction-prompt.md'

async function compact({ conversation, keepTokens, tokensPerChar: ratio, resolvedModel, abortSignal, heartbeat, log }: CompactRunParams): Promise<boolean> {
    const fromIndex = conversation.summarizedUpToIndex ?? 0
    const cut = chatCompactionPlan.cutIndex({ uiMessages: conversation.uiMessages, fromIndex, keepTokens, tokensPerChar: ratio })
    const start = chatContextUtils.transcriptStart({ messages: conversation.uiMessages, summarizedUpToIndex: fromIndex })
    if (isNil(cut) || cut <= start) {
        return false
    }
    const { summary, toIndex } = conversation.autoCompact
        ? await summarizeInSlices({
            previousSummary: conversation.summary,
            uiMessages: conversation.uiMessages,
            start,
            cut,
            maxInputChars: chatCompactionPlan.maxSummaryInputChars({ contextWindowTokens: resolvedModel.contextWindowTokens, tokensPerChar: ratio }),
            resolvedModel,
            abortSignal,
            heartbeat,
        })
        : { summary: withDroppedNote(conversation.summary), toIndex: cut }
    if (toIndex <= start) {
        return false
    }
    const saved = await chatConversationService.saveCompaction({
        id: conversation.id,
        platformId: conversation.platformId,
        userId: conversation.userId,
        fromIndex,
        toIndex,
        // Model output, so external data: a NUL in it would fail the write on every pass after.
        summary: sanitizeObjectForPostgresql(summary),
    })
    log.info({ conversationId: conversation.id, fromIndex, toIndex, summarized: conversation.autoCompact, saved }, '[chatCompaction] moved the transcript start')
    return saved
}

async function summarizeInSlices({ previousSummary, uiMessages, start, cut, maxInputChars, resolvedModel, abortSignal, heartbeat }: SummarizeInSlicesParams): Promise<{ summary: string | null, toIndex: number }> {
    const slices = chatCompactionPlan.summarySlices({ uiMessages, start, cut, maxInputChars }).slice(0, MAX_SUMMARY_CALLS_PER_PASS)
    const instructions = await readFile(COMPACTION_PROMPT_PATH, 'utf-8')
    return slices.reduce<Promise<{ summary: string | null, toIndex: number }>>(async (previous, slice) => {
        const { summary } = await previous
        heartbeat?.()
        return {
            summary: await summarize({ instructions, previousSummary: summary, rendered: slice.rendered, resolvedModel, abortSignal }),
            toIndex: slice.endIndex,
        }
    }, Promise.resolve({ summary: previousSummary, toIndex: start }))
}

async function summarize({ instructions, previousSummary, rendered, resolvedModel, abortSignal }: SummarizeParams): Promise<string> {
    const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
    const { text } = await generateText({
        model: resolvedModel.model,
        system: instructions,
        prompt: renderForSummary({ previousSummary, rendered }),
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        abortSignal: isNil(abortSignal) ? timeout : AbortSignal.any([abortSignal, timeout]),
    })
    const summary = text.trim()
    if (summary.length === 0) {
        // Written as if it were a summary, an empty reply would silently erase the previous one.
        throw new Error('The model returned an empty summary')
    }
    return summary
}

function renderForSummary({ previousSummary, rendered }: { previousSummary: string | null, rendered: string }): string {
    // Indented like every rendered line: an earlier pass may have written a line that begins "User:".
    const earlier = isNil(previousSummary) || previousSummary.trim().length === 0
        ? []
        : ['## Summary so far', indentContinuation(`  ${previousSummary}`), '']
    return [
        ...earlier,
        '## Conversation to add to the summary',
        rendered,
    ].join('\n')
}

// Continuation lines are indented, whatever part they come from, so that only a real user turn can
// start a line with "User:" — the prompt tells the summarizer those lines, and nothing else, are the
// user's. Text and a third-party error message are where raw line breaks arrive.
function renderMessage(message: PersistedChatMessage): string {
    return message.parts
        .flatMap((part) => renderPart({ role: message.role, part }))
        .map(indentContinuation)
        .join('\n')
}

function renderPart({ role, part }: { role: PersistedChatRole, part: PersistedChatPart }): string[] {
    const speaker = role === PersistedChatRole.USER ? 'User' : 'Assistant'
    switch (part.type) {
        case PersistedChatPartType.TEXT:
            return part.text.trim().length === 0 ? [] : [`${speaker}: ${part.text}`]
        case PersistedChatPartType.TOOL_CALL:
            return [`Tool ${part.toolName}(${clip({ text: JSON.stringify(part.input), max: MAX_TOOL_INPUT_CHARS })}) ${part.status}: ${clip({ text: JSON.stringify(part.output ?? part.errorText ?? null), max: MAX_TOOL_OUTPUT_CHARS })}`]
        case PersistedChatPartType.TOOL_APPROVAL_REQUEST:
            return [`Assistant asked the user to approve ${part.toolName}(${clip({ text: JSON.stringify(part.input), max: MAX_TOOL_INPUT_CHARS })})`]
        case PersistedChatPartType.TOOL_APPROVAL_RESPONSE:
            return [`User ${part.approved ? 'approved' : 'declined'} it${isNil(part.reason) ? '' : `: ${part.reason}`}`]
        case PersistedChatPartType.ACTION_RECEIPT:
            return [`Ran ${part.actionDisplayName} (${part.qadamName}): ${part.status}${isNil(part.errorMessage) ? '' : ` — ${clip({ text: part.errorMessage, max: MAX_TOOL_OUTPUT_CHARS })}`}`]
        // Reasoning is never replayed, so it is not summarised either; status lines and progress
        // bars restate what the tool calls already say.
        case PersistedChatPartType.REASONING:
        case PersistedChatPartType.THINKING_STATUS:
        case PersistedChatPartType.BATCH_PROGRESS:
            return []
    }
}

// Every line break a model might read as one, not only `\n`: a bare CR, VT, FF or a Unicode separator
// would otherwise let the text after it start a line.
function indentContinuation(line: string): string {
    return line.replaceAll(LINE_BREAK, '\n  ')
}

function withDroppedNote(summary: string | null): string | null {
    if (isNil(summary) || summary.trim().length === 0 || summary.endsWith(DROPPED_WITHOUT_SUMMARY_NOTE)) {
        return summary
    }
    return `${summary}\n${DROPPED_WITHOUT_SUMMARY_NOTE}`
}

function toCompactionState(conversation: ChatConversation): CompactionState {
    return {
        id: conversation.id,
        platformId: conversation.platformId,
        userId: conversation.userId,
        uiMessages: conversation.uiMessages ?? [],
        summary: conversation.summary ?? null,
        summarizedUpToIndex: conversation.summarizedUpToIndex ?? null,
        autoCompact: conversation.autoCompact,
    }
}

function clip({ text, max }: { text: string, max: number }): string {
    return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`
}

// The newest reply's own measurement, if it has one. An older one would describe a transcript the
// last reply no longer had.
function lastMeasurement(uiMessages: PersistedChatMessage[]): ChatContextUsage | null {
    const lastReply = [...uiMessages].reverse().find((message) => message.role === PersistedChatRole.ASSISTANT)
    const parsed = ChatContextUsageSchema.safeParse(lastReply?.contextUsage)
    return parsed.success ? parsed.data : null
}

// What a message puts on the wire when replayed: everything but reasoning, which never is.
function messageChars(message: PersistedChatMessage): number {
    return message.parts
        .filter((part) => part.type !== PersistedChatPartType.REASONING)
        .map((part) => JSON.stringify(part).length)
        .reduce(sum, 0)
}

function joinRendered(parts: string[]): string {
    return parts.filter((part) => part.length > 0).join('\n')
}

function sum(total: number, value: number): number {
    return total + value
}

type CompactParams = {
    id: string
    platformId: string
    userId: string
    resolvedModel: ResolvedChatModel
}

type CompactForOverflowParams = CompactParams & {
    abortSignal: AbortSignal
    heartbeat: () => void
}

type CompactionState = {
    id: string
    platformId: string
    userId: string
    uiMessages: PersistedChatMessage[]
    summary: string | null
    summarizedUpToIndex: number | null
    autoCompact: boolean
}

type CompactRunParams = {
    conversation: CompactionState
    keepTokens: number
    tokensPerChar: number
    resolvedModel: ResolvedChatModel
    abortSignal: AbortSignal | null
    heartbeat: (() => void) | null
    log: FastifyBaseLogger
}

type CutIndexParams = {
    uiMessages: PersistedChatMessage[]
    fromIndex: number
    keepTokens: number
    tokensPerChar: number
}

type SummarySlicesParams = {
    uiMessages: PersistedChatMessage[]
    start: number
    cut: number
    maxInputChars: number
}

type SummarySlice = {
    // The index the transcript can start at once this slice is in the summary.
    endIndex: number
    rendered: string
}

type SummarizeInSlicesParams = {
    previousSummary: string | null
    uiMessages: PersistedChatMessage[]
    start: number
    cut: number
    maxInputChars: number
    resolvedModel: ResolvedChatModel
    abortSignal: AbortSignal | null
    heartbeat: (() => void) | null
}

type SummarizeParams = {
    instructions: string
    previousSummary: string | null
    rendered: string
    resolvedModel: ResolvedChatModel
    abortSignal: AbortSignal | null
}

type TokensPerCharParams = {
    usage: ChatContextUsage
    uiMessages: PersistedChatMessage[]
    summarizedUpToIndex: number | null
}

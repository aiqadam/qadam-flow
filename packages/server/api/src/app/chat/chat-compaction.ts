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
            await compact({
                conversation: toCompactionState(conversation),
                keepTokens: chatContextUtils.contextBudget(usage).keepTokens,
                tokensPerChar: tokensPerChar({ usage, uiMessages, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null, summary: conversation.summary ?? null }),
                resolvedModel,
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
     */
    async compactForOverflow({ id, platformId, userId, resolvedModel }: CompactParams): Promise<boolean> {
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
                tokensPerChar: isNil(usage) ? DEFAULT_TOKENS_PER_CHAR : tokensPerChar({ usage, uiMessages, summarizedUpToIndex: conversation.summarizedUpToIndex ?? null, summary: conversation.summary ?? null }),
                resolvedModel,
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
}

// 60% of the window would compact; after a refusal, keep a fifth of it.
const CHAT_OVERFLOW_KEEP_RATIO = 0.2
// The usual rule of thumb for English prose and JSON, used only when there is no measurement to
// calibrate against.
const DEFAULT_TOKENS_PER_CHAR = 0.25
// Tool outputs are what make a build session long — a flow's JSON, a qadam's props. The summary needs
// what a call did and what came of it, not the payload, and an unbounded input would let the pass
// itself overflow the window it exists to protect.
const MAX_TOOL_INPUT_CHARS = 1_000
const MAX_TOOL_OUTPUT_CHARS = 2_000
const MAX_SUMMARY_OUTPUT_TOKENS = 2_000
const SUMMARY_TIMEOUT_MS = 90_000
// Same relative-to-cwd form as the system prompt (`chat-agent.service.ts`, `SYSTEM_PROMPT_PATH`).
const COMPACTION_PROMPT_PATH = 'packages/server/api/src/assets/prompts/chat-compaction-prompt.md'

async function compact({ conversation, keepTokens, tokensPerChar: ratio, resolvedModel, log }: CompactRunParams): Promise<boolean> {
    const fromIndex = conversation.summarizedUpToIndex ?? 0
    const cut = chatCompactionPlan.cutIndex({ uiMessages: conversation.uiMessages, fromIndex, keepTokens, tokensPerChar: ratio })
    const start = chatContextUtils.transcriptStart({ messages: conversation.uiMessages, summarizedUpToIndex: fromIndex })
    if (isNil(cut) || cut <= start) {
        return false
    }
    const summary = conversation.autoCompact
        ? await summarize({ previousSummary: conversation.summary, leaving: conversation.uiMessages.slice(start, cut), resolvedModel })
        : conversation.summary
    const saved = await chatConversationService.saveCompaction({
        id: conversation.id,
        platformId: conversation.platformId,
        userId: conversation.userId,
        fromIndex,
        toIndex: cut,
        summary,
    })
    log.info({ conversationId: conversation.id, fromIndex, toIndex: cut, summarized: conversation.autoCompact, saved }, '[chatCompaction] moved the transcript start')
    return saved
}

async function summarize({ previousSummary, leaving, resolvedModel }: SummarizeParams): Promise<string> {
    const instructions = await readFile(COMPACTION_PROMPT_PATH, 'utf-8')
    const { text } = await generateText({
        model: resolvedModel.model,
        system: instructions,
        prompt: renderForSummary({ previousSummary, leaving }),
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    })
    const summary = text.trim()
    if (summary.length === 0) {
        // Written as if it were a summary, an empty reply would silently erase the previous one.
        throw new Error('The model returned an empty summary')
    }
    return summary
}

function renderForSummary({ previousSummary, leaving }: { previousSummary: string | null, leaving: PersistedChatMessage[] }): string {
    const earlier = isNil(previousSummary) || previousSummary.trim().length === 0
        ? []
        : ['## Summary so far', previousSummary, '']
    const transcript = leaving.flatMap((message) => message.parts.flatMap((part) => renderPart({ role: message.role, part })))
    return [
        ...earlier,
        '## Conversation to add to the summary',
        ...transcript,
    ].join('\n')
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
            return [`Ran ${part.actionDisplayName} (${part.qadamName}): ${part.status}${isNil(part.errorMessage) ? '' : ` — ${part.errorMessage}`}`]
        // Reasoning is never replayed, so it is not summarised either; status lines and progress
        // bars restate what the tool calls already say.
        case PersistedChatPartType.REASONING:
        case PersistedChatPartType.THINKING_STATUS:
        case PersistedChatPartType.BATCH_PROGRESS:
            return []
    }
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

// Calibrates the character estimate against what the provider actually counted for the same
// history, so the kept tail is sized in this model's tokens rather than a rule of thumb.
function tokensPerChar({ usage, uiMessages, summarizedUpToIndex, summary }: TokensPerCharParams): number {
    const start = chatContextUtils.transcriptStart({ messages: uiMessages, summarizedUpToIndex })
    const characters = uiMessages.slice(start).map(messageChars).reduce(sum, 0) + (summary?.length ?? 0)
    const tokens = chatContextUtils.contextBudget(usage).conversationTokens
    if (characters === 0 || tokens === 0) {
        return DEFAULT_TOKENS_PER_CHAR
    }
    return Math.min(1, Math.max(0.05, tokens / characters))
}

// What a message puts on the wire when replayed: everything but reasoning, which never is.
function messageChars(message: PersistedChatMessage): number {
    return message.parts
        .filter((part) => part.type !== PersistedChatPartType.REASONING)
        .map((part) => JSON.stringify(part).length)
        .reduce(sum, 0)
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
    log: FastifyBaseLogger
}

type CutIndexParams = {
    uiMessages: PersistedChatMessage[]
    fromIndex: number
    keepTokens: number
    tokensPerChar: number
}

type SummarizeParams = {
    previousSummary: string | null
    leaving: PersistedChatMessage[]
    resolvedModel: ResolvedChatModel
}

type TokensPerCharParams = {
    usage: ChatContextUsage
    uiMessages: PersistedChatMessage[]
    summarizedUpToIndex: number | null
    summary: string | null
}

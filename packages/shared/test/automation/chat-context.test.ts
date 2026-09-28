import { describe, expect, it } from 'vitest'
import { CHAT_COMPACT_AT_RATIO, CHAT_COMPACTION_KEEP_RATIO, ChatContextUsage, chatContextUtils, DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, ReplayableChatMessage } from '../../src'

describe('chatContextUtils.transcriptStart', () => {
    it('replays everything while nothing has been compacted', () => {
        expect(chatContextUtils.transcriptStart({ messages: exchanges(30), summarizedUpToIndex: null })).toBe(0)
    })

    it('starts where the last compaction pass stopped', () => {
        const messages = exchanges(10)

        expect(chatContextUtils.transcriptStart({ messages, summarizedUpToIndex: 6 })).toBe(6)
    })

    it('moves forward to a user turn that has text, so the transcript never opens on an answer', () => {
        const messages = [...exchanges(2), user(''), assistant(), user('next'), assistant()]

        // Index 3 is an assistant turn and index 4 a files-only user turn; 6 is the first with text.
        expect(chatContextUtils.transcriptStart({ messages, summarizedUpToIndex: 3 })).toBe(6)
    })

    it('stays on the boundary when no user turn follows it', () => {
        const messages = [...exchanges(2), assistant()]

        expect(chatContextUtils.transcriptStart({ messages, summarizedUpToIndex: 4 })).toBe(4)
    })

    it('clamps a boundary past the end of the list', () => {
        expect(chatContextUtils.transcriptStart({ messages: exchanges(2), summarizedUpToIndex: 99 })).toBe(4)
    })
})

describe('chatContextUtils.contextBudget', () => {
    const usage: ChatContextUsage = {
        modelId: 'm',
        usedTokens: 81_000,
        contextWindowTokens: 200_000,
        breakdown: { systemPrompt: 7_000, tools: 16_000, toolCount: 51, messages: 13_000, toolOutputs: 45_000 },
    }

    it('takes the thresholds from the room left after the system prompt and tool schemas', () => {
        const budget = chatContextUtils.contextBudget(usage)

        expect(budget.fixedTokens).toBe(23_000)
        expect(budget.conversationTokens).toBe(58_000)
        expect(budget.compactAtTokens).toBe(23_000 + Math.round(177_000 * CHAT_COMPACT_AT_RATIO))
        expect(budget.keepTokens).toBe(Math.round(177_000 * CHAT_COMPACTION_KEEP_RATIO))
    })

    it('assumes the default window when the model has none recorded', () => {
        expect(chatContextUtils.contextBudget({ ...usage, contextWindowTokens: null }).windowTokens).toBe(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
    })

    it('is due only once the reply went past the threshold', () => {
        const { compactAtTokens } = chatContextUtils.contextBudget(usage)

        expect(chatContextUtils.isCompactionDue({ ...usage, usedTokens: compactAtTokens })).toBe(false)
        expect(chatContextUtils.isCompactionDue({ ...usage, usedTokens: compactAtTokens + 1 })).toBe(true)
    })
})

function exchanges(count: number): ReplayableChatMessage[] {
    return Array.from({ length: count }, (_, index) => [user(`question ${index}`), assistant()]).flat()
}

function user(text: string): ReplayableChatMessage {
    return { role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(): ReplayableChatMessage {
    return { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }
}

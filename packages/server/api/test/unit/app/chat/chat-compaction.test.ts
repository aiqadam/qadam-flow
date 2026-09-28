import { ChatContextUsage, PersistedChatMessage, PersistedChatPartType, PersistedChatRole } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOneOrThrow = vi.fn()
const saveCompaction = vi.fn()
const generateText = vi.fn()

vi.mock('../../../../src/app/chat/chat-conversation.service', () => ({
    chatConversationService: { getOneOrThrow: (args: unknown) => getOneOrThrow(args), saveCompaction: (args: unknown) => saveCompaction(args) },
}))
vi.mock('ai', async (importOriginal) => ({
    ...(await importOriginal<typeof import('ai')>()),
    generateText: (args: unknown) => generateText(args),
}))

import { chatCompaction, chatCompactionPlan } from '../../../../src/app/chat/chat-compaction'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
const resolvedModel = { model: 'language-model', modelId: 'm', contextWindowTokens: 10_000, provider: 'custom' } as never

function user(text: string): PersistedChatMessage {
    return { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text }] }
}

function assistant(text: string, contextUsage?: ChatContextUsage): PersistedChatMessage {
    return { role: PersistedChatRole.ASSISTANT, parts: [{ type: PersistedChatPartType.TEXT, text }], ...(contextUsage ? { contextUsage } : {}) }
}

// Each exchange is ~1,000 characters, so at 0.25 tokens per character ~250 tokens.
function exchanges(count: number): PersistedChatMessage[] {
    return Array.from({ length: count }, (_, index) => [user(`q${index} ${'x'.repeat(450)}`), assistant(`a${index} ${'y'.repeat(450)}`)]).flat()
}

function usage(usedTokens: number): ChatContextUsage {
    return {
        modelId: 'm',
        usedTokens,
        contextWindowTokens: 10_000,
        breakdown: { systemPrompt: 1_000, tools: 1_000, toolCount: 3, messages: usedTokens - 2_000, toolOutputs: 0 },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('chatCompactionPlan.cutIndex', () => {
    it('keeps the newest messages that fit, starting on a user turn', () => {
        const uiMessages = exchanges(10)

        const cut = chatCompactionPlan.cutIndex({ uiMessages, fromIndex: 0, keepTokens: 1_100, tokensPerChar: 0.25 })

        // Four exchanges (~1,000 tokens) fit in 1,100; a fifth would not.
        expect(cut).toBe(12)
        expect(uiMessages[cut ?? 0].role).toBe(PersistedChatRole.USER)
    })

    it('always keeps the last exchange, however large', () => {
        const uiMessages = [...exchanges(3), user('z'.repeat(40_000)), assistant('done')]

        expect(chatCompactionPlan.cutIndex({ uiMessages, fromIndex: 0, keepTokens: 100, tokensPerChar: 0.25 })).toBe(6)
    })

    it('has nothing to do when everything after the start is already the last exchange', () => {
        const uiMessages = [...exchanges(3)]

        expect(chatCompactionPlan.cutIndex({ uiMessages, fromIndex: 4, keepTokens: 1, tokensPerChar: 0.25 })).toBeNull()
    })
})

describe('chatCompaction.compactAfterReply', () => {
    it('summarises the messages leaving the transcript together with the previous summary', async () => {
        const uiMessages = [...exchanges(19), user('latest'), assistant('reply', usage(9_000))]
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages, summary: '- Earlier facts.', summarizedUpToIndex: 4, autoCompact: true })
        generateText.mockResolvedValue({ text: '- Earlier facts.\n- New facts.' })
        saveCompaction.mockResolvedValue(true)

        await chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })

        const prompt: string = generateText.mock.calls[0][0].prompt
        expect(prompt).toContain('- Earlier facts.')
        // The summary covers what leaves, starting at the old boundary, and never what stays.
        expect(prompt).toContain('q2 ')
        expect(prompt).not.toContain('q1 ')
        expect(prompt).not.toContain('latest')
        const saved = saveCompaction.mock.calls[0][0]
        expect(saved).toMatchObject({ id: 'c', platformId: 'p', userId: 'u', fromIndex: 4, summary: '- Earlier facts.\n- New facts.' })
        expect(saved.toIndex).toBeGreaterThan(4)
        expect(uiMessages[saved.toIndex].role).toBe(PersistedChatRole.USER)
    })

    it('does nothing while the last reply is under the threshold', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(5), user('q'), assistant('a', usage(3_000))], summary: null, summarizedUpToIndex: null, autoCompact: true })

        await chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })

        expect(generateText).not.toHaveBeenCalled()
        expect(saveCompaction).not.toHaveBeenCalled()
    })

    it('does nothing without a measurement to decide on', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(30)], summary: null, summarizedUpToIndex: null, autoCompact: true })

        await chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })

        expect(saveCompaction).not.toHaveBeenCalled()
    })

    it('with auto-compact off, moves the start without asking the model and keeps the summary as it was', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(19), user('latest'), assistant('reply', usage(9_000))], summary: null, summarizedUpToIndex: null, autoCompact: false })
        saveCompaction.mockResolvedValue(true)

        await chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })

        expect(generateText).not.toHaveBeenCalled()
        expect(saveCompaction.mock.calls[0][0]).toMatchObject({ fromIndex: 0, summary: null })
    })

    it('leaves the conversation untouched when the model fails, and does not throw', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(19), user('latest'), assistant('reply', usage(9_000))], summary: null, summarizedUpToIndex: null, autoCompact: true })
        generateText.mockRejectedValue(new Error('provider down'))

        await expect(chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })).resolves.toBeUndefined()

        expect(saveCompaction).not.toHaveBeenCalled()
    })

    it('refuses an empty summary rather than erasing the previous one', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(19), user('latest'), assistant('reply', usage(9_000))], summary: '- Keep me.', summarizedUpToIndex: null, autoCompact: true })
        generateText.mockResolvedValue({ text: '   ' })

        await chatCompaction(log).compactAfterReply({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })

        expect(saveCompaction).not.toHaveBeenCalled()
    })
})

describe('chatCompaction.compactForOverflow', () => {
    it('compacts without a measurement and reports whether the transcript got shorter', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(30), user('latest')], summary: null, summarizedUpToIndex: null, autoCompact: true })
        generateText.mockResolvedValue({ text: '- Facts.' })
        saveCompaction.mockResolvedValue(true)

        expect(await chatCompaction(log).compactForOverflow({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })).toBe(true)
        expect(saveCompaction.mock.calls[0][0].toIndex).toBeGreaterThan(0)
    })

    it('reports false when another pass got there first', async () => {
        getOneOrThrow.mockResolvedValue({ id: 'c', platformId: 'p', userId: 'u', uiMessages: [...exchanges(30), user('latest')], summary: null, summarizedUpToIndex: null, autoCompact: true })
        generateText.mockResolvedValue({ text: '- Facts.' })
        saveCompaction.mockResolvedValue(false)

        expect(await chatCompaction(log).compactForOverflow({ id: 'c', platformId: 'p', userId: 'u', resolvedModel })).toBe(false)
    })
})

import { CHAT_MAX_REPLAYED_MESSAGES, chatContextUtils, ReplayableChatMessage } from '../../src/lib/automation/chat'

describe('chatContextUtils.replayWindowStart', () => {
    it('keeps a conversation that fits the window whole', () => {
        expect(chatContextUtils.replayWindowStart(exchanges(CHAT_MAX_REPLAYED_MESSAGES / 2))).toBe(0)
    })

    it('drops the oldest messages of a conversation longer than the window', () => {
        const messages = exchanges(CHAT_MAX_REPLAYED_MESSAGES)

        expect(chatContextUtils.replayWindowStart(messages)).toBe(messages.length - CHAT_MAX_REPLAYED_MESSAGES)
    })

    it('moves the start forward to a user turn rather than open on an assistant reply', () => {
        // One past the window, so its oldest remaining message is an assistant reply.
        const messages = [...exchanges(CHAT_MAX_REPLAYED_MESSAGES / 2), user('newest')]
        const start = chatContextUtils.replayWindowStart(messages)

        expect(start).toBe(2)
        expect(messages[start].role).toBe('user')
    })

    it('skips a files-only user turn, which replays as nothing', () => {
        const messages = [user('dropped'), user(''), assistant(), ...exchanges(CHAT_MAX_REPLAYED_MESSAGES / 2 - 1)]

        expect(chatContextUtils.replayWindowStart(messages)).toBe(3)
    })

    it('reads UI-shaped parts the same way as persisted ones', () => {
        const messages: ReplayableChatMessage[] = [
            user('dropped'),
            { role: 'user', parts: [{ type: 'file' }] },
            { role: 'assistant', parts: [{ type: 'dynamic-tool' }, { type: 'text', text: 'ok' }] },
            ...exchanges(CHAT_MAX_REPLAYED_MESSAGES / 2 - 1),
        ]

        expect(chatContextUtils.replayWindowStart(messages)).toBe(3)
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

import { describe, expect, it } from 'vitest'
import { chatThinkingDuration } from '../../../../src/app/chat/chat-thinking-duration'

describe('chatThinkingDuration.measure', () => {
    it('measures from the run start to the first reply text', () => {
        expect(chatThinkingDuration.measure({ startedAt: 1_000, replyStartedAt: 4_000, endedAt: 9_000 })).toBe(3_000)
    })

    it('measures to the end of the stream when the run wrote no text', () => {
        expect(chatThinkingDuration.measure({ startedAt: 1_000, replyStartedAt: null, endedAt: 9_000 })).toBe(8_000)
    })

    it('rounds to whole milliseconds and never goes below zero', () => {
        expect(chatThinkingDuration.measure({ startedAt: 10.2, replyStartedAt: 1_010.7, endedAt: 2_000 })).toBe(1_001)
        expect(chatThinkingDuration.measure({ startedAt: 5_000, replyStartedAt: 4_000, endedAt: 6_000 })).toBe(0)
    })
})

describe('chatThinkingDuration.isReplyText', () => {
    it('counts a text delta that carries text', () => {
        expect(chatThinkingDuration.isReplyText({ type: 'text-delta', id: '0', delta: 'Hi' })).toBe(true)
    })

    it('does not count an empty delta, reasoning, or anything that is not a chunk', () => {
        expect(chatThinkingDuration.isReplyText({ type: 'text-delta', id: '0', delta: '' })).toBe(false)
        expect(chatThinkingDuration.isReplyText({ type: 'reasoning-delta', id: '0', delta: 'Checking.' })).toBe(false)
        expect(chatThinkingDuration.isReplyText({ type: 'text-start', id: '0' })).toBe(false)
        expect(chatThinkingDuration.isReplyText(null)).toBe(false)
        expect(chatThinkingDuration.isReplyText('text-delta')).toBe(false)
    })
})

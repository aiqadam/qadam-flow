import { PersistedChatMessage, PersistedChatPartType, PersistedChatRole, PersistedToolCallStatus } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { chatTranscript } from '../../../../src/app/chat/chat-transcript'

function assistantWithToolCall({ status, output }: { status: PersistedToolCallStatus, output: unknown }): PersistedChatMessage {
    return {
        role: PersistedChatRole.ASSISTANT,
        parts: [{
            type: PersistedChatPartType.TOOL_CALL,
            toolCallId: 'call_1',
            toolName: 'ap_list_flows',
            title: 'List flows',
            input: {},
            output,
            status,
        }],
    }
}

describe('chatTranscript.toModelMessages', () => {
    it('pairs every tool call with a tool message, or the provider rejects the transcript', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'list my flows' }] },
            assistantWithToolCall({ status: PersistedToolCallStatus.COMPLETED, output: { flows: [] } }),
        ])

        expect(replayed.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    })

    it('replays a completed call with its output', () => {
        const replayed = chatTranscript.toModelMessages([
            assistantWithToolCall({ status: PersistedToolCallStatus.COMPLETED, output: { flows: ['a'] } }),
        ])

        expect(replayed[1].content).toEqual([
            expect.objectContaining({ output: { type: 'text', value: '{"flows":["a"]}' } }),
        ])
    })

    // The case that matters: a failed call replayed as a success is a lie the model cannot see
    // through. It stops retrying and stops explaining, because as far as it can tell the tool
    // worked and returned nothing.
    it('replays a failed call as an error, not as a successful empty result', () => {
        const replayed = chatTranscript.toModelMessages([
            assistantWithToolCall({ status: PersistedToolCallStatus.ERROR, output: 'flow not found' }),
        ])

        expect(replayed[1].content).toEqual([
            expect.objectContaining({ output: { type: 'error-text', value: 'flow not found' } }),
        ])
    })

    // `JSON.stringify(new Error('x'))` is `"{}"` — the failure detail vanishes silently.
    it('keeps the message of a failure recorded as an Error rather than stringifying it away', () => {
        const replayed = chatTranscript.toModelMessages([
            assistantWithToolCall({ status: PersistedToolCallStatus.ERROR, output: new Error('invalid tool input') }),
        ])

        expect(replayed[1].content).toEqual([
            expect.objectContaining({ output: { type: 'error-text', value: 'invalid tool input' } }),
        ])
    })

    it('says so rather than sending an empty error when a failure carries no detail', () => {
        const replayed = chatTranscript.toModelMessages([
            assistantWithToolCall({ status: PersistedToolCallStatus.ERROR, output: undefined }),
        ])

        expect(replayed[1].content).toEqual([
            expect.objectContaining({ output: { type: 'error-text', value: 'The tool call failed and reported no detail.' } }),
        ])
    })

    it('drops an assistant turn with nothing in it instead of sending an empty message', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.ASSISTANT, parts: [{ type: PersistedChatPartType.THINKING_STATUS, text: 'Quick check on your flows' }] },
        ])

        expect(replayed).toEqual([])
    })

    it('joins the text parts of a user turn and skips a turn with no text', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'one' }, { type: PersistedChatPartType.TEXT, text: 'two' }] },
            { role: PersistedChatRole.USER, parts: [] },
        ])

        expect(replayed).toEqual([{ role: 'user', content: 'one\ntwo' }])
    })
})

describe('chatTranscript.toModelMessages — history window', () => {
    function turn(role: PersistedChatRole, text: string): PersistedChatMessage {
        return { role, parts: [{ type: PersistedChatPartType.TEXT, text }] }
    }

    function longHistory(count: number): PersistedChatMessage[] {
        return Array.from({ length: count }, (_unused, index) => turn(
            index % 2 === 0 ? PersistedChatRole.USER : PersistedChatRole.ASSISTANT,
            `turn ${index}`,
        ))
    }

    it('replays a short conversation whole', () => {
        expect(chatTranscript.toModelMessages(longHistory(6))).toHaveLength(6)
    })

    // Unbounded replay makes every turn cost more than the last; tool outputs dominate and a long
    // build session accumulates a lot of them.
    it('caps what a long conversation re-sends', () => {
        const replayed = chatTranscript.toModelMessages(longHistory(60))

        expect(replayed.length).toBeLessThanOrEqual(20)
        expect(JSON.stringify(replayed)).toContain('turn 59')
        expect(JSON.stringify(replayed)).not.toContain('turn 0')
    })

    // Opening on an assistant turn would show the model its own reply to a question that is no
    // longer in the transcript.
    it('starts the window on a user turn', () => {
        const replayed = chatTranscript.toModelMessages(longHistory(61))

        expect(replayed[0].role).toBe('user')
    })
})

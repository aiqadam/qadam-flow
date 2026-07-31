import { PersistedChatMessage, PersistedChatPart, PersistedChatPartType, PersistedChatRole, PersistedToolCallStatus } from '@aiqadam/shared'
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

// A gated call is persisted as an approval request rather than as a tool call (`chat-ai-utils.ts`),
// so replay has to rebuild the call from it. Two SDK preconditions decide the shape, both verified
// in `ai@6.0.170`'s bundle: `collectToolApprovals` looks up the request's `toolCallId` among the
// `tool-call` parts of earlier assistant messages and throws `ToolCallNotFoundForApprovalError`
// when it is absent (`index.mjs:2741-2745`), and it does nothing at all unless the *last* message
// is the `role: 'tool'` one carrying the responses (`:2687-2696`).
describe('chatTranscript.toModelMessages — an approval gate', () => {
    const APPROVAL_ID = 'approval_1'

    function gatedCallPart(): PersistedChatPart {
        return {
            type: PersistedChatPartType.TOOL_APPROVAL_REQUEST,
            approvalId: APPROVAL_ID,
            toolCallId: 'call_1',
            toolName: 'ap_delete_flow',
            input: { flowId: 'flow_1' },
        }
    }

    it('replays the gated call so the SDK can find it when the approval is answered', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.ASSISTANT, parts: [gatedCallPart()] },
        ])

        expect(replayed[0].content).toEqual([
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'ap_delete_flow', input: { flowId: 'flow_1' } },
            { type: 'tool-approval-request', approvalId: APPROVAL_ID, toolCallId: 'call_1' },
        ])
    })

    // The bug #264 leaves behind if the gate is replayed as a plain unresolved call: the model is
    // told the delete was attempted and failed, so it apologises or retries rather than waiting.
    it('never tells the model the gated call failed', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.ASSISTANT, parts: [gatedCallPart()] },
        ])

        const answer = replayed.find((message) => message.role === 'tool')
        expect(answer, 'the gated call was left unanswered').toBeDefined()
        expect(JSON.stringify(answer)).not.toContain('error-text')
        expect(JSON.stringify(answer)).not.toContain('failed')
    })

    // An assistant `tool-call` with no answer of any kind makes `convertToLanguageModelPrompt`
    // throw `MissingToolResultsError` on the next user turn (`index.mjs:1379-1391`), which would
    // kill every later run in the conversation. Until the gate is answered, the honest answer is
    // that the call did not run.
    it('answers a still-pending gate, so a later turn is not rejected outright', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.ASSISTANT, parts: [gatedCallPart()] },
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'actually, never mind' }] },
        ])

        expect(replayed[1]).toEqual({
            role: 'tool',
            content: [{
                type: 'tool-result',
                toolCallId: 'call_1',
                toolName: 'ap_delete_flow',
                output: { type: 'text', value: 'Not executed. This action is waiting for the user to approve it.' },
            }],
        })
    })

    // The mirror of the case above: once the user has answered, a `tool-result` for the gated call
    // must NOT be replayed, because `collectToolApprovals` skips any approval whose tool call
    // already has a result (`index.mjs:2739`) — the tool would then never run.
    it('replays an answered gate as the approval response alone, so the SDK executes the tool', () => {
        const replayed = chatTranscript.toModelMessages([
            {
                role: PersistedChatRole.ASSISTANT,
                parts: [
                    gatedCallPart(),
                    { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
                ],
            },
        ])

        expect(replayed.at(-1)).toEqual({
            role: 'tool',
            content: [{ type: 'tool-approval-response', approvalId: APPROVAL_ID, approved: true }],
        })
    })

    it('carries the reason of a denial through', () => {
        const replayed = chatTranscript.toModelMessages([
            {
                role: PersistedChatRole.ASSISTANT,
                parts: [
                    gatedCallPart(),
                    { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: false, reason: 'wrong flow' },
                ],
            },
        ])

        expect(replayed.at(-1)).toEqual({
            role: 'tool',
            content: [{ type: 'tool-approval-response', approvalId: APPROVAL_ID, approved: false, reason: 'wrong flow' }],
        })
    })

    // `collectToolApprovals` returns nothing unless `messages.at(-1).role === 'tool'`, so an
    // approval that is not the final message resumes into a run that silently never executes it.
    it('leaves the approval response as the last message of the transcript', () => {
        const replayed = chatTranscript.toModelMessages([
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'delete that flow' }] },
            {
                role: PersistedChatRole.ASSISTANT,
                parts: [
                    { type: PersistedChatPartType.TEXT, text: 'That will delete it permanently.' },
                    gatedCallPart(),
                    { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
                ],
            },
        ])

        expect(replayed.at(-1)?.role).toBe('tool')
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

describe('chatTranscript.toModelMessages — a turn that produces nothing', () => {
    // A files-only message is stored with empty text and replays as nothing. If the window opened
    // on one, the transcript would start with an assistant turn — the shape a provider rejects.
    it('skips past a user turn that replays as nothing when choosing where the window starts', () => {
        // 21 messages, so the 20-message window opens exactly on index 1 — the files-only turn.
        const history: PersistedChatMessage[] = [
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'dropped by the window' }] },
            { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: '' }] },
            ...Array.from({ length: 19 }, (_unused, index): PersistedChatMessage => ({
                role: index % 2 === 0 ? PersistedChatRole.ASSISTANT : PersistedChatRole.USER,
                parts: [{ type: PersistedChatPartType.TEXT, text: `turn ${index}` }],
            })),
        ]

        const replayed = chatTranscript.toModelMessages(history)

        expect(replayed[0].role).toBe('user')
        expect(replayed[0].content).not.toBe('')
    })
})

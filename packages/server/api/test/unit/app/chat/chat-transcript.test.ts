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
        // `resumingGate` is required for this shape: it is what suppresses the outcome tool-result
        // that every other run must send. Without it the SDK would see a settled call and skip it.
        const replayed = chatTranscript.toModelMessages([
            {
                role: PersistedChatRole.ASSISTANT,
                parts: [
                    gatedCallPart(),
                    { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
                ],
            },
        ], { resumingGate: true })

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
        ], { resumingGate: true })

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

    // `collectToolApprovals` throws `InvalidToolApprovalError` for a response whose request it cannot
    // find (`index.mjs:2735`), and that kills the run before its first token. The coupling in
    // `chatApprovals.answer` means an orphan cannot occur today — request and response share a
    // message, so the window cannot keep one and drop the other — and this is what keeps the transcript
    // safe if that coupling is ever broken.
    it('drops an approval response whose request is not in the replayed window', () => {
        const replayed = chatTranscript.toModelMessages([
            {
                role: PersistedChatRole.ASSISTANT,
                parts: [
                    { type: PersistedChatPartType.TEXT, text: 'Right.' },
                    { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: 'approval_from_a_lost_turn', approved: true },
                ],
            },
        ])

        expect(JSON.stringify(replayed)).not.toContain('approval_from_a_lost_turn')
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

// The defect this suite could not see before: every assistant `tool-call` we replay must be answered
// by something in the following tool message, or the provider rejects the whole request (OpenAI:
// "must be followed by tool messages responding to each tool_call_id"; Anthropic: "tool_use ids were
// found without tool_result blocks"). The integration tests cannot catch it — their scripted provider
// accepts any body — so the invariant is asserted here, on the shape we send.
describe('chatTranscript.toModelMessages — every replayed tool call is answered', () => {
    function gateMessage({ approved }: { approved: boolean | null }): PersistedChatMessage {
        const parts: PersistedChatPart[] = [{
            type: PersistedChatPartType.TOOL_APPROVAL_REQUEST,
            approvalId: 'aitxt-abc',
            toolCallId: 'call_gate',
            toolName: 'ap_delete_flow',
            input: { flowId: 'flow_1' },
        }]
        if (approved !== null) {
            parts.push({
                type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE,
                approvalId: 'aitxt-abc',
                approved,
            })
        }
        return { role: PersistedChatRole.ASSISTANT, parts }
    }

    const userTurn = (text: string): PersistedChatMessage => ({
        role: PersistedChatRole.USER,
        parts: [{ type: PersistedChatPartType.TEXT, text }],
    })

    // The text the model is actually shown for a settled gate.
    function outcomeFor(messages: ReturnType<typeof chatTranscript.toModelMessages>, toolCallId: string): string {
        for (const message of messages) {
            if (message.role !== 'tool' || !Array.isArray(message.content)) {
                continue
            }
            for (const part of message.content) {
                if (part.type === 'tool-result' && part.toolCallId === toolCallId && part.output.type === 'text') {
                    return part.output.value
                }
            }
        }
        throw new Error(`no tool-result for ${toolCallId}`)
    }

    // Collects the ids the provider would see as unanswered, which is exactly what it rejects on.
    function unansweredToolCallIds(messages: ReturnType<typeof chatTranscript.toModelMessages>): string[] {
        const answered = new Set<string>()
        for (const message of messages) {
            if (message.role !== 'tool' || !Array.isArray(message.content)) {
                continue
            }
            for (const part of message.content) {
                if (part.type === 'tool-result') {
                    answered.add(part.toolCallId)
                }
            }
        }
        const called: string[] = []
        for (const message of messages) {
            if (message.role !== 'assistant' || !Array.isArray(message.content)) {
                continue
            }
            for (const part of message.content) {
                if (part.type === 'tool-call') {
                    called.push(part.toolCallId)
                }
            }
        }
        return called.filter((id) => !answered.has(id))
    }

    it.each([
        ['approved', true],
        ['denied', false],
    ])('answers an %s gate once the conversation has moved on', (_label, approved) => {
        const messages = chatTranscript.toModelMessages([
            userTurn('delete that flow'),
            gateMessage({ approved: approved as boolean }),
            userTurn('never mind, list my flows'),
        ])

        expect(
            unansweredToolCallIds(messages),
            'the provider would reject this request: an assistant tool call has no tool result',
        ).toEqual([])
        expect(outcomeFor(messages, 'call_gate')).toContain(approved ? 'approved' : 'declined')
    })

    // The shape `chatAgentService.start` actually builds, and the one an earlier version of this fix
    // got wrong: it converts `uiMessages.slice(0, -1)` and re-adds the user turn as a bare
    // `ModelMessage` afterwards. That leaves the gate message LAST in the converted window, so any
    // exception keyed on array position fires on precisely the path that needed the answer — the
    // user who ignored the card and typed again. The exception is keyed on the caller's intent now,
    // and this test is what holds that.
    it.each([
        ['approved', true],
        ['denied', false],
    ])('answers an %s gate when the next run is started, not resumed', (_label, approved) => {
        const uiMessages = [
            userTurn('delete that flow'),
            gateMessage({ approved: approved as boolean }),
            userTurn('never mind, list my flows'),
        ]

        // `resumingGate` deliberately left at its default: `start` is not resuming a gate.
        const messages = chatTranscript.toModelMessages(uiMessages.slice(0, -1))

        expect(
            unansweredToolCallIds(messages),
            'start() would send the provider an unanswered tool call, and every later turn would fail',
        ).toEqual([])
        // The decision itself, not just the presence of a result. Without this the ternary that
        // picks the wording is untested: inverting it would tell the model a declined destructive
        // action had been authorised, and every other assertion here would stay green.
        expect(outcomeFor(messages, 'call_gate')).toContain(approved ? 'approved' : 'declined')
    })

    it('still answers a gate that is waiting for the user', () => {
        const messages = chatTranscript.toModelMessages([userTurn('delete that flow'), gateMessage({ approved: null })])

        expect(unansweredToolCallIds(messages)).toEqual([])
    })

    // The one exception, and the reason this cannot simply always emit a result: on the newest turn
    // the resume run is about to execute the approved call, and `collectToolApprovals` skips a call
    // that already has a result — so a result here would make the approval silently do nothing.
    it('leaves the gate unanswered only for the run that is resuming it', () => {
        const uiMessages = [userTurn('delete that flow'), gateMessage({ approved: true })]

        expect(
            unansweredToolCallIds(chatTranscript.toModelMessages(uiMessages, { resumingGate: true })),
            'the resume run must not see a result, or collectToolApprovals skips the call and the approved tool never runs',
        ).toEqual(['call_gate'])
        // Same array, ordinary run: it must be answered.
        expect(unansweredToolCallIds(chatTranscript.toModelMessages(uiMessages))).toEqual([])
    })
})

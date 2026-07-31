/**
 * #264. The gate's bookkeeping, in isolation.
 *
 * The integration suite (`test/integration/ce/chat/chat-tool-approval.test.ts`) proves the endpoint
 * behaves; these cases pin the two structural properties that suite cannot show directly — that the
 * response lands in the *same message* as the request, and that the auto-denial touches only gates
 * still waiting.
 */
import {
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedChatRole,
} from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { chatApprovals } from '../../../../src/app/chat/chat-approvals'

const APPROVAL_ID = 'aitxt-0123456789abcdefghijklmn'

function requestPart(approvalId = APPROVAL_ID, toolCallId = 'call_1'): PersistedChatPart {
    return {
        type: PersistedChatPartType.TOOL_APPROVAL_REQUEST,
        approvalId,
        toolCallId,
        toolName: 'ap_delete_flow',
        input: { flowId: 'flow_1' },
    }
}

function transcript(...parts: PersistedChatPart[]): PersistedChatMessage[] {
    return [
        { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: 'delete that flow' }] },
        { role: PersistedChatRole.ASSISTANT, parts },
    ]
}

describe('chatApprovals.findPending', () => {
    it('reports the tool and the arguments, because a name alone is not something a user can authorise', () => {
        expect(chatApprovals.findPending(transcript(requestPart()))).toEqual({
            gateId: APPROVAL_ID,
            toolCallId: 'call_1',
            toolName: 'ap_delete_flow',
            displayName: 'Delete flow',
            toolInput: { flowId: 'flow_1' },
        })
    })

    it('reports the first of two gates raised in one step', () => {
        const pending = chatApprovals.findPending(transcript(requestPart('a', 'call_1'), requestPart('b', 'call_2')))

        expect(pending?.gateId).toBe('a')
    })

    it('reports nothing for an answered gate', () => {
        const answered = transcript(
            requestPart(),
            { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
        )

        expect(chatApprovals.findPending(answered)).toBeNull()
    })

    it('reports nothing for a conversation that never ran', () => {
        expect(chatApprovals.findPending(null)).toBeNull()
    })
})

describe('chatApprovals.answer', () => {
    // The coupling that makes the whole thing work. `chat-transcript.ts` decides which approvals are
    // answered from one message's own parts, and a message holding only a response produces no
    // assistant content and is dropped from the replay — so a response written anywhere else is either
    // invisible or discarded.
    it('appends the response to the same message that carries the request', () => {
        const { uiMessages } = chatApprovals.answer({
            uiMessages: transcript(requestPart()),
            approvalId: APPROVAL_ID,
            approved: true,
            reason: undefined,
            expectedToolCallId: undefined,
        })

        expect(uiMessages).toHaveLength(2)
        expect(uiMessages[1].parts).toEqual([
            requestPart(),
            { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
        ])
    })

    it('returns the request as persisted, so no caller has to trust the answer for the call it names', () => {
        const { request } = chatApprovals.answer({
            uiMessages: transcript(requestPart()),
            approvalId: APPROVAL_ID,
            approved: false,
            reason: 'not that one',
            expectedToolCallId: 'call_1',
        })

        expect(request.toolCallId).toBe('call_1')
    })

    it('refuses an approval id that names no gate', () => {
        expect(() => chatApprovals.answer({
            uiMessages: transcript(requestPart()),
            approvalId: 'nope',
            approved: true,
            reason: undefined,
            expectedToolCallId: undefined,
        })).toThrow(/ENTITY_NOT_FOUND|not found/i)
    })

    it('refuses a second answer to the same gate', () => {
        const answered = transcript(
            requestPart(),
            { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
        )

        expect(() => chatApprovals.answer({
            uiMessages: answered,
            approvalId: APPROVAL_ID,
            approved: true,
            reason: undefined,
            expectedToolCallId: undefined,
        })).toThrow()
    })

    it('refuses an answer that names a different tool call than the gate it addresses', () => {
        expect(() => chatApprovals.answer({
            uiMessages: transcript(requestPart('a', 'call_1'), requestPart('b', 'call_2')),
            approvalId: 'a',
            approved: true,
            reason: undefined,
            expectedToolCallId: 'call_2',
        })).toThrow()
    })
})

describe('chatApprovals.denyOutstanding', () => {
    it('denies a gate the user walked away from, with the reason the model will read', () => {
        const denied = chatApprovals.denyOutstanding({
            uiMessages: transcript(requestPart()),
            reason: 'moved on',
        })

        expect(denied[1].parts.at(-1)).toEqual({
            type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE,
            approvalId: APPROVAL_ID,
            approved: false,
            reason: 'moved on',
        })
    })

    it('denies both gates when a step raised two', () => {
        const denied = chatApprovals.denyOutstanding({
            uiMessages: transcript(requestPart('a', 'call_1'), requestPart('b', 'call_2')),
            reason: 'moved on',
        })

        const responses = denied[1].parts.filter((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE)
        expect(responses).toHaveLength(2)
    })

    // Otherwise a user who approves and then immediately sends a message overwrites their own approval
    // with a denial, and the tool they authorised never runs.
    it('leaves an already-answered gate alone', () => {
        const answered = transcript(
            requestPart(),
            { type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE, approvalId: APPROVAL_ID, approved: true },
        )

        expect(chatApprovals.denyOutstanding({ uiMessages: answered, reason: 'moved on' })).toEqual(answered)
    })

    it('returns the transcript untouched when nothing is waiting', () => {
        const clean = transcript({ type: PersistedChatPartType.TEXT, text: 'all done' })

        expect(chatApprovals.denyOutstanding({ uiMessages: clean, reason: 'moved on' })).toBe(clean)
    })
})

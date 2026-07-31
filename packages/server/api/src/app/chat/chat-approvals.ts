/**
 * #264. The bookkeeping for a tool-approval gate, over `uiMessages` and nothing else.
 *
 * A gate is a pair of persisted parts, not a row: `TOOL_APPROVAL_REQUEST` written by the run that
 * was stopped, `TOOL_APPROVAL_RESPONSE` written by the person who answered. There is deliberately no
 * gate entity — the AI SDK resumes from the transcript, so a second source of truth for the same
 * fact could only ever disagree with it.
 *
 * Everything here is pure. The caller holds the row lock; these functions decide what the next
 * `uiMessages` should be and refuse when the answer is not applicable.
 */
import {
    ErrorCode,
    isNil,
    PendingChatToolApproval,
    PersistedChatMessage,
    PersistedChatPartType,
    PersistedChatRole,
    PersistedToolApprovalRequestPart,
    QadamFlowError,
    spreadIfDefined,
} from '@aiqadam/shared'

export const chatApprovals = {
    // The first gate still waiting, in transcript order. First rather than last because the model
    // can gate two calls in one step, and answering them in the order they were asked is the only
    // order the user can reason about.
    findPending(uiMessages: PersistedChatMessage[] | null): PendingChatToolApproval | null {
        const outstanding = outstandingRequests(uiMessages ?? [])
        const first = outstanding[0]
        if (isNil(first)) {
            return null
        }
        return {
            gateId: first.approvalId,
            toolCallId: first.toolCallId,
            toolName: first.toolName,
            displayName: toDisplayName(first.toolName),
            toolInput: first.input,
        }
    },

    /**
     * Records the answer to one gate, or refuses.
     *
     * The response part is appended to **the same message that carries the request**, and that
     * coupling is load-bearing rather than tidy — see the matching comment in
     * `chat-transcript.ts`. `toAssistantModelMessages` computes which approvals are answered from
     * one message's own parts, and a message whose parts produce no assistant content is dropped
     * from the replay entirely, so a response written as a new message would be invisible at best
     * and silently discarded at worst.
     */
    answer({ uiMessages, approvalId, approved, reason, expectedToolCallId }: AnswerParams): AnsweredGate {
        const messages = uiMessages ?? []
        const location = assertAnswerable({ uiMessages: messages, approvalId, expectedToolCallId })
        return {
            request: location.request,
            uiMessages: withResponses({
                messages,
                responses: [{ messageIndex: location.messageIndex, approvalId, approved, reason }],
            }),
        }
    },

    /**
     * The same three refusals as `answer`, without writing anything.
     *
     * Exists so the endpoint can reject an unanswerable gate *before* resolving the project, the
     * provider, the model and the tool set — none of which a bad approval id should have to depend
     * on. Without it a conversation on a platform with no chat provider answered "no provider
     * configured" to an approval id that simply does not exist, which is a worse answer than 404 and
     * hides the real one. It is a pre-flight, not the check: `answer` runs it again inside the
     * transaction with the row locked, and that run is the authoritative one.
     */
    assertAnswerable,

    /**
     * Denies every gate still waiting.
     *
     * Called when a new user message is admitted. A user who ignores the card and simply types again
     * otherwise leaves the gate outstanding for the rest of the conversation: the card keeps coming
     * back on every reload, and an approval clicked later resumes a run in which
     * `collectToolApprovals` no longer looks at the response at all — it only reads the *last*
     * message — so the tool silently never runs and the model is never told why. Recording the
     * denial closes the gate, tells the model in the next turn's transcript that the action was not
     * taken, and keeps the single-use rule meaningful.
     */
    denyOutstanding({ uiMessages, reason }: DenyOutstandingParams): PersistedChatMessage[] {
        const messages = uiMessages ?? []
        const responses = messages.flatMap((message, messageIndex) => message.parts.flatMap((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST
            && !isAnswered({ message, approvalId: part.approvalId })
            ? [{ messageIndex, approvalId: part.approvalId, approved: false, reason }]
            : []))
        return responses.length === 0 ? messages : withResponses({ messages, responses })
    },

    toDisplayName,
}

function assertAnswerable({ uiMessages, approvalId, expectedToolCallId }: AssertAnswerableParams): GateLocation {
    const messages = uiMessages ?? []
    const location = locate({ messages, approvalId })
    if (isNil(location)) {
        // The same error the conversation lookup raises for someone else's row, for the same reason:
        // an approval id that does not exist and one that belongs to a gate the caller cannot see
        // must be indistinguishable, or the endpoint enumerates gates.
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: approvalId, entityType: 'ChatToolApprovalGate' },
        })
    }
    // Single-use. Without this an answered gate could be answered again, and because the resumed run
    // executes the tool itself, a replayed "approve" is a replayed destructive tool call.
    if (isAnswered({ message: messages[location.messageIndex], approvalId })) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'This action has already been answered.' },
        })
    }
    // Compared, never used to choose the call. Two gated calls can sit in one step, so a client whose
    // card is out of date would otherwise approve whichever gate the id happens to reach.
    if (!isNil(expectedToolCallId) && expectedToolCallId !== location.request.toolCallId) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'This approval does not match the action it was raised for.' },
        })
    }
    return location
}

function outstandingRequests(messages: PersistedChatMessage[]): PersistedToolApprovalRequestPart[] {
    return messages.flatMap((message) => message.parts.flatMap((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST
        && !isAnswered({ message, approvalId: part.approvalId })
        ? [part]
        : []))
}

// Scoped to the one message, which is the same scope `chat-transcript.ts` reads it in. Widening it
// would make a gate look answered here while replaying as unanswered there.
function isAnswered({ message, approvalId }: { message: PersistedChatMessage, approvalId: string }): boolean {
    return message.parts.some((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE && part.approvalId === approvalId)
}

function locate({ messages, approvalId }: { messages: PersistedChatMessage[], approvalId: string }): GateLocation | null {
    for (const [messageIndex, message] of messages.entries()) {
        for (const part of message.parts) {
            if (part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST && part.approvalId === approvalId) {
                return { messageIndex, request: part }
            }
        }
    }
    return null
}

// Rebuilt rather than mutated in place: `uiMessages` is a json column read straight off the locked
// row, and the repo prefers producing new collections over writing through a caller's array.
function withResponses({ messages, responses }: { messages: PersistedChatMessage[], responses: PendingResponse[] }): PersistedChatMessage[] {
    return messages.map((message, messageIndex) => {
        const forThisMessage = responses.filter((response) => response.messageIndex === messageIndex)
        if (forThisMessage.length === 0) {
            return message
        }
        return {
            ...message,
            role: PersistedChatRole.ASSISTANT,
            parts: [
                ...message.parts,
                ...forThisMessage.map((response) => ({
                    type: PersistedChatPartType.TOOL_APPROVAL_RESPONSE as const,
                    approvalId: response.approvalId,
                    approved: response.approved,
                    ...spreadIfDefined('reason', response.reason),
                })),
            ],
        }
    })
}

// The tool name is the only label the server has — `McpToolDefinition.title` *is* the snake_case
// name, and there is no display-name registry to read. Building the tool set to find a nicer string
// would mean resolving permissions and the project's MCP config on a read of one pending gate.
function toDisplayName(toolName: string): string {
    const words = toolName.replace(/^ap_/, '').split('_').filter((word) => word.length > 0)
    if (words.length === 0) {
        return toolName
    }
    return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ')
}

type GateLocation = {
    messageIndex: number
    request: PersistedToolApprovalRequestPart
}

type PendingResponse = {
    messageIndex: number
    approvalId: string
    approved: boolean
    reason: string | undefined
}

type AssertAnswerableParams = {
    uiMessages: PersistedChatMessage[] | null
    approvalId: string
    expectedToolCallId: string | undefined
}

type AnswerParams = AssertAnswerableParams & {
    approved: boolean
    reason: string | undefined
}

type DenyOutstandingParams = {
    uiMessages: PersistedChatMessage[] | null
    reason: string
}

export type AnsweredGate = {
    request: PersistedToolApprovalRequestPart
    uiMessages: PersistedChatMessage[]
}

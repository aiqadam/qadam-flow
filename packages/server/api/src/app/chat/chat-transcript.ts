import {
    isNil,
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedChatRole,
    PersistedToolCallPart,
    PersistedToolCallStatus,
    spreadIfDefined,
} from '@aiqadam/shared'
import { ModelMessage, TextPart, ToolApprovalRequest, ToolApprovalResponse, ToolCallPart, ToolResultPart } from 'ai'

export const chatTranscript = {
    // Rebuilt from `uiMessages`, which is a schema-validated shape we own, rather than from the raw
    // `messages` JSON blob — the AI SDK exports no runtime schema for `ModelMessage`, so reading
    // that back would need a cast this repo does not allow. What is lost by that: prior-turn
    // reasoning, because `toAssistantModelMessages` below emits only text and tool-call parts.
    // That is the behaviour we want — Anthropic rejects a re-sent `thinking` block whose signature
    // did not survive the round trip — but it is a property of this function, not something a
    // helper does for us. (`chatAiUtils.stripThinkingBlocks` exists and would do it; it has no
    // caller anywhere, so nothing here relies on it.) Tool-call/result pairs survive intact.
    toModelMessages(uiMessages: PersistedChatMessage[]): ModelMessage[] {
        return recentTurns(uiMessages).flatMap((message) => message.role === PersistedChatRole.USER
            ? toUserModelMessages(message.parts)
            : toAssistantModelMessages(message.parts))
    },
}

// Replaying the whole history every turn makes each message cost more than the last, without
// bound: tool outputs are the bulk of it and a long build session accumulates a lot of them. The
// entity carries `summary`/`summarizedUpToIndex` for a proper compaction pass, which nothing
// writes yet — until it does, a window is the honest version of the same idea. It has to start on
// a user turn, or the transcript can open with an assistant message answering a question the model
// can no longer see, and it must never split an assistant turn from the tool results that answer
// its calls, which is why the whole message is the unit.
function recentTurns(uiMessages: PersistedChatMessage[]): PersistedChatMessage[] {
    if (uiMessages.length <= MAX_REPLAYED_MESSAGES) {
        return uiMessages
    }
    const window = uiMessages.slice(-MAX_REPLAYED_MESSAGES)
    // The first user turn that actually produces a message, not merely the first user turn: a
    // files-only message is persisted with empty text, `toUserModelMessages` drops it, and the
    // transcript would then open with an assistant turn answering a question the model can no
    // longer see — which is the one shape a provider rejects outright.
    const firstReplayableTurn = window.findIndex((message) => message.role === PersistedChatRole.USER
        && toUserModelMessages(message.parts).length > 0)
    return firstReplayableTurn <= 0 ? window : window.slice(firstReplayableTurn)
}

function toUserModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const text = parts
        .flatMap((part) => part.type === PersistedChatPartType.TEXT ? [part.text] : [])
        .join('\n')
    return text.length === 0 ? [] : [{ role: 'user', content: text }]
}

function toAssistantModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const content: Array<TextPart | ToolCallPart | ToolApprovalRequest> = []
    const toolResults: Array<ToolResultPart | ToolApprovalResponse> = []

    const answeredApprovalIds = new Set(parts.flatMap((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE
        ? [part.approvalId]
        : []))

    for (const part of parts) {
        if (part.type === PersistedChatPartType.TEXT) {
            content.push({ type: 'text', text: part.text })
        }
        if (part.type === PersistedChatPartType.TOOL_CALL) {
            content.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
            toolResults.push({
                type: 'tool-result',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: toReplayedToolOutput(part),
            })
        }
        if (part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST) {
            // The `tool-call` is rebuilt here even though it was deliberately not persisted as one:
            // `collectToolApprovals` resolves the approval's `toolCallId` against the `tool-call`
            // parts of earlier assistant messages and throws `ToolCallNotFoundForApprovalError`
            // when it finds none, so a resumed run cannot execute the tool without it.
            content.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
            content.push({ type: 'tool-approval-request', approvalId: part.approvalId, toolCallId: part.toolCallId })
            // Only while the gate is unanswered. Once it is, this result would make
            // `collectToolApprovals` treat the call as already settled and skip executing it — and
            // before then its absence would make the next user turn throw `MissingToolResultsError`,
            // which poisons the conversation for good. It is worded as a fact rather than as a
            // failure because the model's next move should be to wait, not to retry or apologise.
            if (!answeredApprovalIds.has(part.approvalId)) {
                toolResults.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: { type: 'text', value: AWAITING_APPROVAL_OUTPUT },
                })
            }
        }
        if (part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE) {
            toolResults.push({
                type: 'tool-approval-response',
                approvalId: part.approvalId,
                approved: part.approved,
                ...spreadIfDefined('reason', part.reason),
            })
        }
    }

    if (content.length === 0) {
        return []
    }
    // A tool message must follow the assistant message that made the calls, or the provider
    // rejects the transcript for having unanswered tool calls. It is also what puts an approval
    // response last when the answered gate is the newest turn — the only arrangement in which
    // `collectToolApprovals` looks at it at all.
    return toolResults.length === 0
        ? [{ role: 'assistant', content }]
        : [{ role: 'assistant', content }, { role: 'tool', content: toolResults }]
}

// A tool call that failed must replay as a failure. Sending `null` for it — which is what a plain
// `output ?? null` does — tells the model on the next turn that the call succeeded and returned
// nothing, so it neither retries nor explains, and prompt rule 27's "diagnose the specific error"
// has no error to read. An `Error` object also stringifies to `{}`, which is the same lie in a
// different shape, so the message is lifted out explicitly.
function toReplayedToolOutput(part: PersistedToolCallPart): ToolResultPart['output'] {
    if (part.status === PersistedToolCallStatus.ERROR) {
        return { type: 'error-text', value: describeToolFailure(part.output) }
    }
    // Text rather than `{ type: 'json' }` because the persisted output is `unknown` and the JSON
    // variant demands a proven `JSONValue`.
    return { type: 'text', value: JSON.stringify(part.output ?? null) }
}

function describeToolFailure(output: unknown): string {
    if (output instanceof Error) {
        return output.message
    }
    if (typeof output === 'string') {
        return output
    }
    if (isNil(output)) {
        return 'The tool call failed and reported no detail.'
    }
    return JSON.stringify(output)
}

const AWAITING_APPROVAL_OUTPUT = 'Not executed. This action is waiting for the user to approve it.'

// Twenty messages is roughly ten exchanges — enough that a build session keeps its thread, while
// capping what any single turn re-sends.
const MAX_REPLAYED_MESSAGES = 20

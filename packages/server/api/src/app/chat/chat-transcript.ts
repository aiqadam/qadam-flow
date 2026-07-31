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
    // `resumingGate` is the caller stating what this transcript is for, and it must not be inferred
    // from the array. Only the run started by an approval is about to execute a settled gate; every
    // other run has to answer it. Inferring it from "is the gate the last message" was wrong,
    // because `start` passes `uiMessages.slice(0, -1)` and re-adds the user turn afterwards — which
    // makes an auto-denied gate the last element on exactly the path that needed the answer.
    toModelMessages(uiMessages: PersistedChatMessage[], { resumingGate = false }: { resumingGate?: boolean } = {}): ModelMessage[] {
        const window = recentTurns(uiMessages)
        // Collected across the whole window rather than per message, so the check below asks the
        // question the SDK asks: is there a request for this response anywhere in what we are about
        // to send?
        const requestedApprovalIds = new Set(window.flatMap((message) => message.parts.flatMap((part) => part.type === PersistedChatPartType.TOOL_APPROVAL_REQUEST
            ? [part.approvalId]
            : [])))
        return window.flatMap((message, index) => message.role === PersistedChatRole.USER
            ? toUserModelMessages(message.parts)
            : toAssistantModelMessages({
                parts: message.parts,
                knownApprovalIds: requestedApprovalIds,
                // `resumingGate` is the condition that decides this; the index check is
                // belt-and-braces. `chatApprovals.assertAnswerable` refuses to answer a gate whose
                // message is not the newest, and `recentTurns` only ever drops *leading* messages,
                // so on the approve path the resumed gate is already guaranteed to be last. Kept
                // because this is a general helper and a future caller could pass a different array
                // — but do not read it as load-bearing, or as a second guard on the same risk.
                isResumedGateTurn: resumingGate && index === window.length - 1,
            }))
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

function toAssistantModelMessages({ parts, knownApprovalIds, isResumedGateTurn }: { parts: PersistedChatPart[], knownApprovalIds: ReadonlySet<string>, isResumedGateTurn: boolean }): ModelMessage[] {
    const content: Array<TextPart | ToolCallPart | ToolApprovalRequest> = []
    const toolResults: Array<ToolResultPart | ToolApprovalResponse> = []

    // Scoped to this one message's parts, which is why the approval response has to be appended to
    // the message that carries the request rather than written as a new one. `chatApprovals.answer`
    // is coupled to this: a response in a separate message would be invisible here, so the gate
    // would replay as still pending, and that message — carrying only a response, which produces no
    // assistant `content` — is dropped entirely by the `content.length === 0` guard below.
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
            // The rebuilt `tool-call` must be answered by something in every case but one, and
            // getting that one exception wrong breaks the conversation in a way no test with a mock
            // provider can see. The three cases:
            //
            // 1. Gate still pending → say so. Worded as a fact rather than a failure because the
            //    model's next move should be to wait, not to retry or apologise.
            // 2. Gate answered, and this run is NOT resuming it → say how it ended. The SDK's
            //    `convertToLanguageModelPrompt` exempts an approval-carrying call from its own
            //    `MissingToolResultsError` (`ai/dist/index.mjs:1319-1331`), which is what made this
            //    look safe — but the exemption only stops the SDK throwing. It then strips the
            //    approval parts (`:1441`, `:1497`) and drops the emptied tool message (`:1393`), so
            //    the provider receives an assistant `tool-call` with nothing responding to it.
            //    OpenAI answers 400 "must be followed by tool messages responding to each
            //    tool_call_id"; Anthropic answers "tool_use ids were found without tool_result
            //    blocks". Every later turn in the conversation fails until the gated turn scrolls
            //    out of the window.
            // 3. Gate answered and this run IS resuming it → emit nothing. The resume run:
            //    `collectToolApprovals` skips a call that already has a result (`:2737`), so a
            //    result here would mean the approved tool silently never executes.
            //
            // The real tool output cannot be used for case 2: the resume run executes the call
            // before the first `start-step`, which resets `recordedContent` (`:6714`), so it never
            // reaches `buildStepParts` and is not persisted. Reporting the outcome is honest and
            // enough for the model; persisting the real output is a separate change.
            const answered = answeredApprovalIds.has(part.approvalId)
            if (!answered) {
                toolResults.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: { type: 'text', value: AWAITING_APPROVAL_OUTPUT },
                })
            }
            else if (!isResumedGateTurn) {
                const approved = parts.some((other) => other.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE
                    && other.approvalId === part.approvalId
                    && other.approved)
                toolResults.push({
                    type: 'tool-result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: { type: 'text', value: approved ? APPROVED_OUTPUT : DECLINED_OUTPUT },
                })
            }
        }
        if (part.type === PersistedChatPartType.TOOL_APPROVAL_RESPONSE) {
            // An orphan response is fatal, not cosmetic: `collectToolApprovals` throws
            // `InvalidToolApprovalError` for a response whose request it cannot find among the
            // replayed messages (`ai/dist/index.mjs:2735`), and that kills every later run in the
            // conversation before its first token. Today the coupling above makes an orphan
            // impossible — the two parts share a message, so the window cannot keep one and drop
            // the other — and this check is what keeps that true if the coupling ever breaks.
            if (!knownApprovalIds.has(part.approvalId)) {
                continue
            }
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
// Replayed on later turns for a gate that has been answered, because the provider requires every
// assistant tool call to be answered by something. Not the tool's real output — see the case list in
// `toAssistantModelMessages` for why that is unavailable here.
const APPROVED_OUTPUT = 'The user approved this action.'
const DECLINED_OUTPUT = 'Not executed. The user declined this action.'

// Twenty messages is roughly ten exchanges — enough that a build session keeps its thread, while
// capping what any single turn re-sends.
const MAX_REPLAYED_MESSAGES = 20

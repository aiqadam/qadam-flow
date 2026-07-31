import {
    isNil,
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedChatRole,
    PersistedToolCallPart,
    PersistedToolCallStatus,
} from '@aiqadam/shared'
import { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai'

export const chatTranscript = {
    // Rebuilt from `uiMessages`, which is a schema-validated shape we own, rather than from the raw
    // `messages` JSON blob — the AI SDK exports no runtime schema for `ModelMessage`, so reading
    // that back would need a cast this repo does not allow. Nothing is lost: `chatAiUtils` strips
    // cross-turn reasoning for every provider anyway, and the tool-call/result pairs survive.
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
    const firstUserTurn = window.findIndex((message) => message.role === PersistedChatRole.USER)
    return firstUserTurn <= 0 ? window : window.slice(firstUserTurn)
}

function toUserModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const text = parts
        .flatMap((part) => part.type === PersistedChatPartType.TEXT ? [part.text] : [])
        .join('\n')
    return text.length === 0 ? [] : [{ role: 'user', content: text }]
}

function toAssistantModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const content: Array<TextPart | ToolCallPart> = []
    const toolResults: ToolResultPart[] = []

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
    }

    if (content.length === 0) {
        return []
    }
    // A tool message must follow the assistant message that made the calls, or the provider
    // rejects the transcript for having unanswered tool calls.
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

// Twenty messages is roughly ten exchanges — enough that a build session keeps its thread, while
// capping what any single turn re-sends.
const MAX_REPLAYED_MESSAGES = 20

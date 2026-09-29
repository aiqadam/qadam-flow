import { isNil } from '@aiqadam/shared'

// How long a run thought before its reply began (#564): from the run's start to its first
// non-empty `text-delta`, or to the end of its stream when it never wrote any text (a turn that
// ends on a tool gate). The browser measures the same two chunks on receipt, and draws a text block
// only from non-empty text, so an empty delta must not end the interval here either.
export const chatThinkingDuration = {
    isReplyText(chunk: unknown): boolean {
        return typeof chunk === 'object' && !isNil(chunk) && 'type' in chunk && chunk.type === 'text-delta'
            && 'delta' in chunk && typeof chunk.delta === 'string' && chunk.delta.length > 0
    },
    measure({ startedAt, replyStartedAt, endedAt }: MeasureParams): number {
        return Math.max(0, Math.round((replyStartedAt ?? endedAt) - startedAt))
    },
}

type MeasureParams = {
    startedAt: number
    replyStartedAt: number | null
    endedAt: number
}

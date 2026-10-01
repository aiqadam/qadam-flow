import { errorUtils } from '../utils/errors'

/**
 * A handler's throw that carries its retry verdict to the poll loop, which reports it to the broker
 * as `ConsumeJobResponse.retryable` (#584). It keeps the original error's message and stack, so the
 * job's failed reason and logs read exactly as they did before, and the original itself for
 * whatever the poll loop reads off it.
 */
export class ClassifiedJobFailure extends Error {
    readonly retryable: boolean
    readonly original: unknown

    constructor({ original, retryable }: ClassifiedJobFailureParams) {
        super(errorUtils.messageOf(original))
        this.name = original instanceof Error ? original.name : 'Error'
        if (original instanceof Error) {
            this.stack = original.stack
        }
        this.original = original
        this.retryable = retryable
    }
}

type ClassifiedJobFailureParams = {
    original: unknown
    retryable: boolean
}

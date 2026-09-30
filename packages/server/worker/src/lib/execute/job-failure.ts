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
        super(original instanceof Error ? original.message : String(original))
        this.name = original instanceof Error ? original.name : 'Error'
        this.stack = original instanceof Error ? original.stack : this.stack
        this.original = original
        this.retryable = retryable
    }
}

type ClassifiedJobFailureParams = {
    original: unknown
    retryable: boolean
}

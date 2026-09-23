import { ExecutionError, ExecutionErrorType } from '@aiqadam/shared'

// USER, not ENGINE: every cause is something the flow author controls — the value itself or the
// URL it points at. propsProcessor catches it per property and reports it through the step's
// validation errors, so it fails the step instead of being swallowed into a `null` input.
export class PropertyProcessingError extends ExecutionError {
    constructor({ message, cause }: { message: string, cause?: unknown }) {
        super('PropertyProcessingError', message, ExecutionErrorType.USER, cause)
    }
}

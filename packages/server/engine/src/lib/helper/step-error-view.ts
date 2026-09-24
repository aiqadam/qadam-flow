import { isNil, tryParseFriendlyQadamError } from '@aiqadam/shared'

export const stepErrorView = {
    // `message` stays the stored string byte for byte: flows written before #387 parse it, and it is
    // the JSON `FriendlyQadamError` for every error a qadam threw. The structured fields are read out
    // of that same string, so logs persisted before this change get them too — except
    // `retryAfterSeconds`, which needs the response headers those logs never kept.
    build({ errorMessage, cache }: BuildParams): StepErrorView {
        const cached = cache.get(errorMessage)
        if (!isNil(cached)) {
            return cached
        }
        const view = toView(errorMessage)
        cache.set(errorMessage, view)
        return view
    },
    retryAfterSeconds({ errorMessage }: { errorMessage: string | undefined }): number | undefined {
        if (isNil(errorMessage)) {
            return undefined
        }
        return readFiniteSeconds(tryParseFriendlyQadamError(errorMessage)?.retryAfterSeconds)
    },
}

// A step can throw an object already shaped like a `FriendlyQadamError`, which is passed through
// without the header parser ever seeing it — so the field is re-checked here rather than trusted.
function readFiniteSeconds(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function toView(errorMessage: string): StepErrorView {
    const parsed = tryParseFriendlyQadamError(errorMessage)
    if (isNil(parsed)) {
        return { message: errorMessage, description: errorMessage }
    }
    return {
        message: errorMessage,
        description: parsed.message,
        status: parsed.status,
        retryAfterSeconds: readFiniteSeconds(parsed.retryAfterSeconds),
        body: parsed.responseBody,
    }
}

type BuildParams = {
    errorMessage: string
    cache: Map<string, StepErrorView>
}

export type StepErrorView = {
    message: string
    description: string
    status?: number
    retryAfterSeconds?: number
    body?: unknown
}

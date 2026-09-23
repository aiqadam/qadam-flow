// DoD 3 of #265: a chat failure must tell the user *what to change*, not just
// "could not finish". Only the error's name, message and numeric HTTP status may be read — never
// the error object: an AI SDK `APICallError` carries `requestBodyValues` and the response headers,
// which is where the provider API key lives. The transport patterns match the messages `safe-http`
// and axios actually produce (packages/server/utils/src/safe-http.ts); the provider patterns match
// what the providers answer in the body the SDK folds into `APICallError.message`.
//
// The input must be the provider's own error, not the `NoOutputGeneratedError` that
// `result.steps` rejects with when the very first step failed: that wrapper's message is a fixed
// "No output generated" and matches nothing here. `runAgentLoop` captures the real one through
// `streamText`'s `onError`.

const FIRST_BYTE_TIMEOUT_RE = /timeout of \d+ms exceeded/i
const IDLE_TIMEOUT_RE = /stopped sending data for \d+s mid-response/i
const SSRF_BLOCKED_RE = /blocked by the ssrf filter/i
// Ollama: `registry.ollama.ai/library/gemma:2b does not support tools`; vLLM without
// `--enable-auto-tool-choice`: `"auto" tool choice requires --enable-auto-tool-choice ...`.
const TOOLS_NOT_SUPPORTED_RE = /does not support tools|tool choice requires|tools? (?:calling |use )?(?:is|are) not supported/i
const CONTEXT_LENGTH_RE = /context length|context window|maximum context|prompt is too long|too many tokens/i
const MODEL_NOT_FOUND_RE = /model[^.]{0,120}not found|model_not_found|no such model/i
const AUTH_RE = /unauthorized|invalid api key|incorrect api key|invalid x-api-key|authentication_error/i
const RATE_LIMIT_RE = /rate limit|too many requests/i
const CONNECTION_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up|cannot connect to api/i

export function classifyChatError(error: unknown): ClassifiedChatError {
    const message = readString({ source: error, key: 'message' })
    const statusCode = readStatusCode(error)
    const rule = RULES.find((candidate) => candidate.matches({ message, statusCode }))
    return rule?.result ?? UNKNOWN_RESULT
}

// Types at the end of the file; exported constants right after imports (AGENTS.md file order).
export const CHAT_ERROR_CODES = {
    PROVIDER_FIRST_BYTE_TIMEOUT: 'PROVIDER_FIRST_BYTE_TIMEOUT',
    PROVIDER_IDLE_TIMEOUT: 'PROVIDER_IDLE_TIMEOUT',
    PROVIDER_SSRF_BLOCKED: 'PROVIDER_SSRF_BLOCKED',
    PROVIDER_TOOLS_NOT_SUPPORTED: 'PROVIDER_TOOLS_NOT_SUPPORTED',
    PROVIDER_CONTEXT_LENGTH_EXCEEDED: 'PROVIDER_CONTEXT_LENGTH_EXCEEDED',
    PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
    PROVIDER_MODEL_NOT_FOUND: 'PROVIDER_MODEL_NOT_FOUND',
    PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
    PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',
    UNKNOWN: 'UNKNOWN',
} as const

// Order is significance, not tidiness: the SSRF enrichment and the timeouts are transport messages
// that can arrive wrapped in `Cannot connect to API: ...`, so they must win over the generic
// connection class; a tools or context refusal is usually a 400 whose body also mentions the model,
// so both must win over "model not found".
const RULES: ClassificationRule[] = [
    {
        matches: ({ message }) => IDLE_TIMEOUT_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_IDLE_TIMEOUT,
            message: 'The AI provider stopped sending data mid-response. If your model can legitimately pause this long, increase AP_HTTP_STREAM_IDLE_TIMEOUT_SECONDS and try again.',
        },
    },
    {
        matches: ({ message }) => FIRST_BYTE_TIMEOUT_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_FIRST_BYTE_TIMEOUT,
            message: 'The AI provider did not send the first token in time. If you run a local or self-hosted model (e.g. Ollama), the first token can take a while — increase AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS and try again.',
        },
    },
    {
        matches: ({ message }) => SSRF_BLOCKED_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_SSRF_BLOCKED,
            message: 'The AI provider could not be reached: the target is blocked by the SSRF filter. If it is a trusted internal host, add its IP or CIDR to the AP_SSRF_ALLOW_LIST environment variable and restart the server.',
        },
    },
    {
        matches: ({ message }) => TOOLS_NOT_SUPPORTED_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_TOOLS_NOT_SUPPORTED,
            message: 'The selected model does not support tool calling, which the assistant needs to work with your flows. Pick a model that supports tools (function calling) in the chat model picker or the platform AI settings.',
        },
    },
    {
        matches: ({ message }) => CONTEXT_LENGTH_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_CONTEXT_LENGTH_EXCEEDED,
            message: 'The conversation no longer fits into the model\'s context window. Start a new conversation, or use a model with a larger context window.',
        },
    },
    {
        matches: ({ message, statusCode }) => statusCode === 401 || statusCode === 403 || AUTH_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_AUTH_FAILED,
            message: 'The AI provider rejected the credentials. An admin should check the API key in the platform AI settings.',
        },
    },
    {
        matches: ({ message, statusCode }) => statusCode === 404 || MODEL_NOT_FOUND_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_MODEL_NOT_FOUND,
            message: 'The AI provider does not know this model or endpoint. Check the model name and the provider base URL in the platform AI settings — for Ollama, make sure the model has been pulled.',
        },
    },
    {
        matches: ({ message, statusCode }) => statusCode === 429 || RATE_LIMIT_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_RATE_LIMITED,
            message: 'The AI provider is rate-limiting requests or the quota is exhausted. Wait a moment and try again, or check the provider account limits.',
        },
    },
    {
        matches: ({ message }) => CONNECTION_RE.test(message),
        result: {
            code: CHAT_ERROR_CODES.PROVIDER_UNREACHABLE,
            message: 'The AI provider could not be reached. Check the provider base URL in the platform AI settings. If Qadam Flow runs in Docker and the model runs on the same machine, use host.docker.internal instead of localhost.',
        },
    },
]

const UNKNOWN_RESULT: ClassifiedChatError = {
    code: CHAT_ERROR_CODES.UNKNOWN,
    message: 'The assistant could not finish this message. Please try again.',
}

function readString({ source, key }: { source: unknown, key: string }): string {
    const value = readProperty({ source, key })
    return typeof value === 'string' ? value : ''
}

// The SDK retries a retryable failure and then throws a `RetryError` whose own message quotes the
// last attempt's but whose status lives on `lastError` — so both are looked at, and only ever the
// number, never the object around it.
function readStatusCode(error: unknown): number | null {
    return readNumber({ source: error, key: 'statusCode' })
        ?? readNumber({ source: readProperty({ source: error, key: 'lastError' }), key: 'statusCode' })
}

function readNumber({ source, key }: { source: unknown, key: string }): number | null {
    const value = readProperty({ source, key })
    return typeof value === 'number' ? value : null
}

function readProperty({ source, key }: { source: unknown, key: string }): unknown {
    if (typeof source !== 'object' || source === null || !(key in source)) {
        return undefined
    }
    return Reflect.get(source, key)
}

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES]

export type ClassifiedChatError = { code: ChatErrorCode, message: string }

type ClassificationRule = {
    matches: (params: { message: string, statusCode: number | null }) => boolean
    result: ClassifiedChatError
}

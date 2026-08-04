// DoD 3 of #265: a chat failure must tell the user *what to change*, not just
// "could not finish". Only the error's name and message may be read — never the error
// object: an AI SDK `APICallError` carries `requestBodyValues` and the response headers,
// which is where the provider API key lives. The patterns match the transport messages
// `safe-http` and axios actually produce (packages/server/utils/src/safe-http.ts).

const FIRST_BYTE_TIMEOUT_RE = /timeout of \d+ms exceeded/i
const IDLE_TIMEOUT_RE = /stopped sending data for \d+s mid-response/i
const SSRF_BLOCKED_RE = /blocked by the ssrf filter/i

function errorMessage(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
        return ''
    }
    const message = error.message
    return typeof message === 'string' ? message : ''
}

export function classifyChatError(error: unknown): ClassifiedChatError {
    const message = errorMessage(error)
    if (IDLE_TIMEOUT_RE.test(message)) {
        return {
            code: CHAT_ERROR_CODES.PROVIDER_IDLE_TIMEOUT,
            message: 'The AI provider stopped sending data mid-response. If your model can legitimately pause this long, increase AP_HTTP_STREAM_IDLE_TIMEOUT_SECONDS and try again.',
        }
    }
    if (FIRST_BYTE_TIMEOUT_RE.test(message)) {
        return {
            code: CHAT_ERROR_CODES.PROVIDER_FIRST_BYTE_TIMEOUT,
            message: 'The AI provider did not send the first token in time. If you run a local or self-hosted model (e.g. Ollama), the first token can take a while — increase AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS and try again.',
        }
    }
    if (SSRF_BLOCKED_RE.test(message)) {
        return {
            code: CHAT_ERROR_CODES.PROVIDER_SSRF_BLOCKED,
            message: 'The AI provider could not be reached: the target is blocked by the SSRF filter. If it is a trusted internal host, add its IP or CIDR to the AP_SSRF_ALLOW_LIST environment variable and restart the server.',
        }
    }
    return {
        code: CHAT_ERROR_CODES.UNKNOWN,
        message: 'The assistant could not finish this message. Please try again.',
    }
}

// Exported types and constants live at the end of the file (CLAUDE.md:61).
export const CHAT_ERROR_CODES = {
    PROVIDER_FIRST_BYTE_TIMEOUT: 'PROVIDER_FIRST_BYTE_TIMEOUT',
    PROVIDER_IDLE_TIMEOUT: 'PROVIDER_IDLE_TIMEOUT',
    PROVIDER_SSRF_BLOCKED: 'PROVIDER_SSRF_BLOCKED',
    UNKNOWN: 'UNKNOWN',
} as const

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES]

export type ClassifiedChatError = { code: ChatErrorCode, message: string }

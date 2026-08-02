import { safeHttp } from '@aiqadam/server-utils'
import { isNil, tryCatch } from '@aiqadam/shared'

/**
 * The only outbound client the AI provider strategies may use.
 *
 * These strategies used to call `httpClient` from `@aiqadam/qadams-common`, which is a bare
 * `new AxiosHttpClient()` — no `request-filtering-agent`, so no private/loopback/link-local/
 * cloud-metadata filtering at all. `.claude/rules/safe-http.md` applies to everything under
 * `packages/server/{api,worker,utils}`, and importing an already-constructed client from another
 * package was simply a way around the lint rule, not an exemption from the requirement (#276).
 *
 * It exists as a helper rather than each provider reaching for `safeHttp.axios` directly because
 * of what axios throws. An `AxiosError` carries the request config, and the config carries the
 * outgoing headers — `api-key`, `x-api-key`, `x-goog-api-key`, `cf-aig-authorization`, or a CUSTOM
 * provider's operator-named header, none of which `loggerRedact`'s static path list can cover.
 * `aiProviderService.validateProviderCredentials` both logs the thrown error (`log.error({ err })`)
 * and puts its message on the wire as `httpErrorResponse`, so anything axios attached would leave
 * the process. Nothing thrown from here is an `AxiosError`: the status and the response body
 * survive, `cause` is deliberately not set, and the config does not escape. Same reasoning, and
 * the same deliberate loss of detail, as `safeHttp.fetch`.
 */
export const providerHttp = {
    async sendJson<T>({ url, method, headers, body }: ProviderJsonRequest): Promise<T> {
        const { data: response, error } = await tryCatch(() => safeHttp.axios.request<T>({
            url,
            method,
            headers,
            data: body,
            responseType: 'json',
            // A provider answering 4xx/5xx must not be reported by axios throwing, or the
            // `AxiosError` that carries the api key becomes the normal path for a bad key.
            validateStatus: () => true,
        }))

        // `response` cannot be null while `error` is, but destructuring drops the discriminant
        // that says so, so both are checked — the same shape as `firstTextModelFromProvider`.
        if (!isNil(error) || isNil(response)) {
            throw new Error(describeTransportFailure(error))
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(describeFailure({ status: response.status, body: response.data }))
        }
        return response.data
    },
}

// Keeps the message and nothing else. `cause` is deliberately not set: that would put the
// `AxiosError`, and with it the request config and the api key, straight back within reach.
function describeTransportFailure(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return isNil(error) ? 'The provider request produced no response' : String(error)
}

function describeFailure({ status, body }: { status: number, body: unknown }): string {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body) ?? ''
    const truncated = serialized.length > MAX_ERROR_BODY_LENGTH
        ? `${serialized.slice(0, MAX_ERROR_BODY_LENGTH)}…`
        : serialized
    return `Request failed with status ${status}: ${truncated}`
}

// The message reaches the settings dialog for Cloudflare Gateway and the server log for everyone
// else; a provider that answers with a megabyte of HTML must not put it in either.
const MAX_ERROR_BODY_LENGTH = 500

export type ProviderJsonRequest = {
    url: string
    method: 'GET' | 'POST'
    headers: Record<string, string>
    body?: unknown
}

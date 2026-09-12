/**
 * Some APIs — Telegram's is the one we call — carry the credential in the URL path, and the HTTP
 * instrumentations record the URL verbatim. Without this, enabling tracing exports a working bot
 * token on every request span to whoever can read the tracing backend.
 *
 * All four attribute names, not just the full-URL ones: instrumentation-undici sets `url.full`,
 * `url.path` and `url.query` side by side, and instrumentation-http sets `http.target` — so
 * redacting only the full URL leaves the credential-bearing path segment exported verbatim.
 */
const URL_ATTRIBUTES = ['url.full', 'http.url', 'url.path', 'http.target']

const CREDENTIAL_IN_PATH_PATTERNS = [/\/bot\d+:[\w-]+/g]

function redactCredentialsInUrl(url: string): string {
    return CREDENTIAL_IN_PATH_PATTERNS.reduce(
        (redacted, pattern) => redacted.replace(pattern, '/bot[REDACTED]'),
        url,
    )
}

export const otelRedaction = {
    urlAttributes: URL_ATTRIBUTES,
    redactCredentialsInUrl,
}

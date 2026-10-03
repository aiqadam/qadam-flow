import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { httpTimeouts, isNil, tryCatch } from '@aiqadam/shared'
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'
import { safeHttpProxy } from './safe-http-proxy'

// Shared across every allow-list this process reads (SSRF's own `AP_SSRF_ALLOW_LIST` and the LDAP
// host guard's separate `AP_LDAP_ALLOW_LIST` in `packages/server/api`) so there is exactly one
// comma-separated-IP/CIDR parser to keep in sync, rather than a second copy that drifts from this
// one. Takes the already-read raw value rather than an env var name: a caller outside this package
// resolves its own variable (via its own `system.get`) and hands the string in, instead of a second
// `process.env` reader.
function parseAllowList(raw: string | undefined): string[] {
    if (!raw) return []
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function parseAllowListFromEnv(): string[] {
    return parseAllowList(process.env['AP_SSRF_ALLOW_LIST'])
}

function buildAgents({ allowList, httpsAgentOptions }: BuildAgentsParams): SsrfAgents {
    const filteringOptions = {
        keepAlive: true,
        allowPrivateIPAddress: false,
        allowLoopbackIPAddress: false,
        allowMetaIPAddress: false,
        allowIPAddressList: allowList,
    }
    return {
        httpAgent: new RequestFilteringHttpAgent(filteringOptions),
        // `proxyEnv` last, so no caller option can turn on Node's built-in proxy support for this
        // agent: that would tunnel to the proxy from inside the agent, and the filter would then
        // check the proxy's address instead of the target's.
        httpsAgent: new RequestFilteringHttpsAgent({ ...filteringOptions, ...httpsAgentOptions, proxyEnv: undefined }),
    }
}

// For a client that takes neither an axios instance nor a `fetch` override, but does take Node
// `http.Agent`s — the AWS SDK's `requestHandler` is the case this exists for. It is the same
// `request-filtering-agent` the axios instances wear, reading the same `AP_SSRF_ALLOW_LIST`, so
// the process still holds exactly one SSRF implementation. `buildAgents` alone is not enough for
// a caller outside this file: the allow list would have to be re-parsed there, and a second copy
// of that parse is precisely how the live filter and the configured one drift apart.
//
// These agents always connect directly and never read `HTTP(S)_PROXY`, so the filter sees the real
// target. Only the axios instances below route through an egress proxy.
function buildDefaultAgents({ httpsAgentOptions }: SafeAxiosOptions = {}): SsrfAgents {
    return buildAgents({ allowList: parseAllowListFromEnv(), httpsAgentOptions })
}

function isSsrfFilterError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = typeof error.message === 'string' ? error.message : ''
    const cause = error.cause instanceof Error ? error.cause.message : ''
    return SSRF_FILTER_MESSAGE_REGEX.test(message) || SSRF_FILTER_MESSAGE_REGEX.test(cause)
}

function attachSsrfErrorInterceptor(instance: AxiosInstance): AxiosInstance {
    instance.interceptors.response.use(undefined, (error: unknown) => {
        if (isSsrfFilterError(error)) {
            const original = error instanceof Error ? error.message : String(error)
            const enriched = `${original} — ${SSRF_REMEDIATION_HINT}`
            if (error instanceof Error) error.message = enriched
        }
        return Promise.reject(error)
    })
    return instance
}

function createAxios(config?: AxiosRequestConfig, { httpsAgentOptions }: SafeAxiosOptions = {}): AxiosInstance {
    const allowList = parseAllowListFromEnv()
    const { httpAgent, httpsAgent } = safeHttpProxy.buildProxyAwareAgents({
        direct: buildAgents({ allowList, httpsAgentOptions }),
        allowList,
        httpsAgentOptions,
    })
    // Invariant: every request leaves through the agents above, which filter the target on the
    // direct route and on the proxied one alike. So axios' own proxy handling stays off, and the
    // interceptor re-pins everything that decides which code opens the connection, because a
    // request's own config overrides the instance defaults: the agents, the HTTP/1.1 transport
    // (the HTTP/2 one does not use agents), the Node `http` adapter, and no custom `transport`,
    // `socketPath` or `lookup`. A caller's `beforeRedirect` runs before every redirect hop, so the
    // agents are pinned again after it. An instance derived from this one with `.create()` does not
    // inherit the interceptor and must not be used for outbound requests.
    const instance = axios.create({
        ...config,
        httpAgent,
        httpsAgent,
        proxy: false,
    })
    instance.interceptors.request.use((requestConfig) => ({
        ...requestConfig,
        httpAgent,
        httpsAgent,
        proxy: false,
        httpVersion: 1,
        adapter: 'http',
        transport: undefined,
        socketPath: undefined,
        lookup: undefined,
        beforeRedirect: pinAgentsAfterRedirectHook({
            hook: requestConfig.beforeRedirect,
            agents: { http: httpAgent, https: httpsAgent },
        }),
    }))
    return attachSsrfErrorInterceptor(instance)
}

// follow-redirects picks each hop's agent from `options.agents`, after the hook has run; the
// socket path is cleared for the same reason as in the request interceptor.
function pinAgentsAfterRedirectHook({ hook, agents }: PinRedirectAgentsParams): BeforeRedirectHook {
    return (options, responseDetails, requestDetails) => {
        hook?.(options, responseDetails, requestDetails)
        options['agents'] = { ...agents }
        options['agent'] = undefined
        options['socketPath'] = undefined
    }
}

function createRetryingAxios(config?: AxiosRequestConfig, options?: SafeAxiosOptions): AxiosInstance {
    const instance = createAxios(config, options)
    axiosRetry(instance, {
        retries: 3,
        retryDelay: () => 2000,
        retryCondition: (error: AxiosError) =>
            !isNil(error.response?.status) && error.response.status >= 500 && error.response.status < 600,
    })
    return instance
}

// A `fetch`-shaped front end over the SSRF-filtered axios instance, for libraries that accept a
// `fetch` override but nothing else — the AI SDK provider factories are the reason this exists.
// Node's global fetch runs on undici, which takes a `dispatcher`, not a `http.Agent`, so
// `request-filtering-agent` cannot be plugged into it; reimplementing the filter against undici
// would mean a second SSRF implementation to keep in step with this one. Going through axios keeps
// exactly one filter in the process, and gets redirect hops filtered too, since follow-redirects
// reuses these agents for every hop.
//
// Positional parameters here are deliberate despite the named-parameter convention: the signature
// has to be assignable to `typeof globalThis.fetch` or the SDKs reject it.
async function safeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    if (request.redirect === 'error') {
        throw new TypeError('safeHttp.fetch: redirect mode "error" is not supported')
    }
    const bodylessMethod = request.method === 'GET' || request.method === 'HEAD'
    // Buffers the request body. Fine for the JSON payloads these SDKs send, and axios would have to
    // materialise a Node stream from the web stream anyway.
    const body = bodylessMethod ? undefined : Buffer.from(await request.arrayBuffer())

    const response = await requestWithoutLeakingCredentials({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        data: body,
        responseType: 'stream',
        // `manual` must not silently follow. axios drops follow-redirects entirely at 0 and returns
        // the 3xx itself, still through the filtering agents.
        ...(request.redirect === 'manual' ? { maxRedirects: 0 } : {}),
        // `fetch` resolves on 4xx/5xx and only rejects on transport failures; axios' default would
        // turn a 429 from the provider into a thrown error the SDK cannot read the body of.
        validateStatus: () => true,
        // Governs the wait for the first byte. axios' `timeout` is socket-inactivity, which is the
        // right shape for a stream in flight — but it also covers the silence *before* one starts,
        // and that silence is long and normal: a cold local model loads gigabytes of weights and
        // evaluates the prompt without sending anything. A 120s value here killed every first
        // message to an idle Ollama at 121s (#265). Generous by default, and configurable, because
        // how long "cold" takes is a property of the operator's hardware, not of this code.
        timeout: firstByteTimeoutSeconds() * 1000,
        signal: request.signal,
    })

    // The Response constructor throws on a body for these statuses, and axios still hands back an
    // (empty) stream for them. HEAD is in the same bucket: real `fetch` gives it a null body.
    const hasNoBody = NULL_BODY_STATUSES.includes(response.status) || request.method === 'HEAD'
    const responseBody = hasNoBody ? null : toWebStream(withIdleGuard(response.data))

    // `url`, `redirected` and `type` cannot be set through the Response constructor, so they read
    // as '', false and 'default' rather than the final URL, the real redirect flag and 'basic'. No
    // AI SDK provider reads them; a library that resolved relative URLs against `response.url`
    // would misbehave here, and would need a different transport rather than a patch to this one.
    return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: toResponseHeaders(response.headers),
    })
}

// Stands in for `Readable.toWeb` for a type reason, not a behavioural one. `toWeb` is typed as the
// `node:stream/web` ReadableStream, while `Response` takes the *global* one, and the two stop being
// the same type as soon as `lib.dom` is in the program: vitest 3.2's `optional-types.d.ts` imports
// `jsdom`, bun's isolated linker makes `@types/jsdom` resolvable from there, and that drags
// `lib.dom` into every test program even though `tsconfig.server.json` leaves it out. A stream
// built by the global constructor is the right type under either lib.
//
// Kept from `toWeb`: one chunk per `pull`, so reads stay paced by the consumer; each chunk copied
// out of its backing buffer; `cancel` destroys the source, which aborts the socket and fires the
// idle guard's `close` listener; a premature close reads as an AbortError. Deliberately different:
// any other source error reaches the reader sanitised like a request-phase error (an axios
// `CanceledError` on a mid-body abort carries the request config, i.e. the provider API key), and
// the cancel reason is not forwarded to `destroy`, so cancelling never emits a stray `error`.
function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
    const chunks = stream[Symbol.asyncIterator]()
    return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
            const { data: chunk, error } = await tryCatch<Uint8Array | null, unknown>(() => readChunk(chunks))
            if (error !== null) {
                // Also covers a throw on this side of the bridge, which would otherwise leave the
                // socket open until the idle guard fired.
                stream.destroy()
                controller.error(sanitizeBodyError(error))
                return
            }
            if (chunk === null) {
                controller.close()
                return
            }
            controller.enqueue(chunk)
        },
        cancel(): void {
            stream.destroy()
        },
    })
}

async function readChunk(chunks: AsyncIterator<unknown>): Promise<Uint8Array | null> {
    const next = await chunks.next()
    return next.done === true ? null : toUint8Array(next.value)
}

// A copy, as `toWeb` makes, never a view: a decompressed chunk is a slice of zlib's whole output
// buffer, and a small socket chunk can be a slice of Node's shared Buffer pool, which also holds
// unrelated allocations. A view would hand the consumer that whole backing store.
function toUint8Array(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) {
        return new Uint8Array(chunk)
    }
    throw new TypeError('safeHttp.fetch: the response stream produced a non-byte chunk')
}

function sanitizeBodyError(error: unknown): Error {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        return new DOMException('The operation was aborted', 'AbortError')
    }
    return sanitizeTransportError(error)
}

// Once the response has started, a much tighter bound applies: a provider that has begun streaming
// and then stops mid-answer is broken, and holding the socket open for the whole first-byte
// allowance would be the very leak the timeout exists to prevent. axios' own timer stays armed at
// the first-byte value, so this is the stricter of the two and the one that governs in practice.
function withIdleGuard(stream: Readable): Readable {
    const idleMs = streamIdleTimeoutSeconds() * 1000
    let timer: NodeJS.Timeout | undefined

    const stop = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
        }
    }
    const arm = (): void => {
        stop()
        timer = setTimeout(() => {
            stream.destroy(new Error(`the provider stopped sending data for ${Math.round(idleMs / 1000)}s mid-response`))
        }, idleMs)
        // Node keeps the process alive for a pending timer; this one must never be the reason a
        // worker will not exit.
        timer.unref?.()
    }

    stream.on('data', arm)
    // Attaching a 'data' listener switches the stream to flowing mode, and anything it emits before
    // the consumer attaches is lost. Pausing keeps the bytes buffered for whoever reads them, so it
    // no longer matters what runs between this and the bridge; 'data' still fires on every read.
    stream.pause()
    stream.once('end', stop)
    stream.once('close', stop)
    stream.once('error', stop)
    arm()
    return stream
}

function readTimeoutSeconds(name: string, fallbackSeconds: number): number {
    const raw = Number(process.env[name])
    // An unset, empty, non-numeric or non-positive value is not a reason to disable the timeout —
    // that failure mode is a permanently pinned socket, so it falls back rather than fails open.
    if (!Number.isFinite(raw) || raw <= 0) {
        return fallbackSeconds
    }
    // Clamped from above for the opposite reason, and it is not tidiness: `setTimeout` truncates its
    // delay to a signed 32-bit integer, so `AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS=3000000` — a plausible
    // way to write "effectively unlimited" — wraps to a 1ms delay and every provider call fails
    // instantly. Since #289 publishes this value to the browser, that would now break both sides.
    return Math.min(raw, httpTimeouts.MAX_TIMEOUT_SECONDS)
}

// Exposed in seconds, not milliseconds, because the browser has to outlast these too and reads them
// off the `HTTP_FIRST_BYTE_TIMEOUT_SECONDS` / `HTTP_STREAM_IDLE_TIMEOUT_SECONDS` flags. Resolving
// the env var once, here, is what keeps the value the operator configured and the value the tab
// waits for from drifting apart (#289).
function firstByteTimeoutSeconds(): number {
    return readTimeoutSeconds('AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS', httpTimeouts.DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS)
}

function streamIdleTimeoutSeconds(): number {
    return readTimeoutSeconds('AP_HTTP_STREAM_IDLE_TIMEOUT_SECONDS', httpTimeouts.DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS)
}

// An `AxiosError` carries the whole request config as an own enumerable property, and that config
// holds the outgoing headers — i.e. the provider API key. Anything that later logs the error
// (`log.error({ err })`) would serialise it. `loggerRedact` only knows the `Authorization` path,
// which misses Anthropic's `x-api-key`, Azure's `api-key`, Google's `x-goog-api-key`, Cloudflare's
// `cf-aig-authorization`, and the CUSTOM provider's operator-named header — unredactable by any
// static path list. `config.data` (the whole prompt) rides along too. So nothing axios threw is
// allowed to escape this function: the message is kept, including the SSRF remediation hint the
// interceptor appends, and the rest is dropped. `cause` is deliberately not set, since that would
// put the config straight back within reach.
async function requestWithoutLeakingCredentials(config: AxiosRequestConfig): Promise<AxiosResponse<Readable>> {
    try {
        return await safeHttp.axios.request<Readable>(config)
    }
    catch (error) {
        throw sanitizeTransportError(error)
    }
}

// Shared by the request phase and the body phase (`toWebStream`): an abort or socket failure after
// the headers carries the same axios config as one before them.
function sanitizeTransportError(error: unknown): Error {
    // The SDK's retry loop asks `isAbortError`, which only recognises DOMException/AbortError —
    // axios' `CanceledError` would make a user-cancelled turn look like a provider failure and get
    // retried. Re-shaping it here is also why the sanitising catch has to sit around the request
    // rather than in the caller.
    if (axios.isCancel(error)) {
        return new DOMException('The operation was aborted', 'AbortError')
    }
    return new Error(error instanceof Error ? error.message : String(error))
}

// Takes the axios header bag rather than a normalised record so the union of shapes axios can hand
// back (`AxiosHeaders` instance or plain object) needs no cast; both expose their headers as own
// enumerable properties.
function toResponseHeaders(raw: object): Headers {
    const headers = new Headers()
    for (const [name, value] of Object.entries(raw)) {
        // These describe the wire response, not the bytes being handed on — `content-length` is
        // stale once axios has decompressed (axios does not clear it), and the framing headers
        // describe a connection the caller never sees. Real `fetch` strips all of them.
        //
        // `content-encoding` is deliberately NOT in this list: axios removes it itself on the
        // branches where it actually decompressed (gzip/deflate/br), so a surviving header means
        // the body really is still encoded — `zstd`, or `br` on a build without brotli. Stripping
        // it unconditionally would hand the caller compressed bytes labelled as plaintext.
        if (WIRE_ONLY_RESPONSE_HEADERS.includes(name.toLowerCase())) {
            continue
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, String(item))
            }
        }
        else if (!isNil(value)) {
            headers.append(name, String(value))
        }
    }
    return headers
}

let lazyDefaultAxios: AxiosInstance | undefined
let lazyRetryingAxios: AxiosInstance | undefined

const NULL_BODY_STATUSES = [101, 103, 204, 205, 304]

const WIRE_ONLY_RESPONSE_HEADERS = ['content-length', 'transfer-encoding', 'connection', 'keep-alive']

const SSRF_FILTER_MESSAGE_REGEX = /(DNS lookup .* not allowed|IP .* is not allowed)/i
const SSRF_REMEDIATION_HINT = 'the target is blocked by the SSRF filter. If it is a trusted internal host (e.g. a self-hosted Vault, Conjur, or OAuth2 provider), add its IP or CIDR to the AP_SSRF_ALLOW_LIST environment variable (comma-separated) and restart the server.'

export const safeHttp = {
    buildAgents,
    buildDefaultAgents,
    createAxios,
    createRetryingAxios,
    fetch: safeFetch,
    firstByteTimeoutSeconds,
    streamIdleTimeoutSeconds,
    parseAllowList,
    get axios(): AxiosInstance {
        lazyDefaultAxios ??= createAxios()
        return lazyDefaultAxios
    },
    get retryingAxios(): AxiosInstance {
        lazyRetryingAxios ??= createRetryingAxios()
        return lazyRetryingAxios
    },
}

export type SsrfAgents = {
    httpAgent: http.Agent
    httpsAgent: https.Agent
}

export type SafeAxiosOptions = {
    httpsAgentOptions?: https.AgentOptions
}

type BuildAgentsParams = {
    allowList: string[]
    httpsAgentOptions?: https.AgentOptions
}

type BeforeRedirectHook = NonNullable<AxiosRequestConfig['beforeRedirect']>

type PinRedirectAgentsParams = {
    hook: AxiosRequestConfig['beforeRedirect']
    agents: { http: http.Agent, https: http.Agent }
}

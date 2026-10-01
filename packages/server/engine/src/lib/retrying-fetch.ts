import { isNil, tryCatch } from '@aiqadam/shared'

/**
 * How long an engine call to the app keeps retrying while the app is unreachable, from its first
 * attempt: no retry starts, and no attempt waits for an answer, after it. It matches the worker's own
 * budget for the same outage, so a run survives an app restart on both of the legs it reports
 * through: these HTTP calls, and the RPCs the worker forwards, which wait up to `READY_TIMEOUT_MS`
 * (60 s, `packages/server/worker/src/lib/reconnect-safe-api-client.ts`) for the reconnected API and
 * are bounded by the engine's own 60 s RPC timeout to the worker (`worker-socket.ts`). It is also
 * about as long as the job is sure to live: the worker trusts a lease for 90 s from its last renewal
 * and renews every 30 s (#585), so during an outage it may give the job up, and kill this engine,
 * from 60 s in. Before #595 this was fetch-retry's 3 retries 3 s apart, about 9 s, so a routine app
 * recreate failed every run that reached its final log upload during it.
 */
const ENGINE_API_RETRY_BUDGET_MS = 60_000

/**
 * How long one attempt may wait for its response headers. Separate from the retry budget on
 * purpose: headers arrive only once the app has the whole request body, so this also counts the
 * upload itself, and a healthy but slow request (a multi-MB run log over a modest link, a 25 MB
 * `files.write`) must not be cut off just because it takes longer than the budget for retries. The
 * same as undici's default `headersTimeout` (`300e3` in `lib/dispatcher/client.js`), which bounded
 * every one of these calls before #595; the explicit timer exists so a test can run it on fake time
 * and so a retry can be held to the budget that is left.
 */
const ENGINE_API_ATTEMPT_TIMEOUT_MS = 300_000

const DEFAULT_POLICY: RetryPolicy = {
    budgetMs: ENGINE_API_RETRY_BUDGET_MS,
    attemptTimeoutMs: ENGINE_API_ATTEMPT_TIMEOUT_MS,
    initialDelayMs: 500,
    maxDelayMs: 5_000,
}

/**
 * For a call that is allowed to fail and is repeated anyway, such as the periodic run-log snapshot.
 * It runs under the progress reporter's lock, so a long budget there would stall every step that
 * reports progress for the whole outage. Same length as the old fetch-retry budget.
 */
const BEST_EFFORT_POLICY: RetryPolicy = {
    budgetMs: 9_000,
    attemptTimeoutMs: ENGINE_API_ATTEMPT_TIMEOUT_MS,
    initialDelayMs: 500,
    maxDelayMs: 3_000,
}

export const retryingFetch = {
    defaultPolicy: DEFAULT_POLICY,
    bestEffortPolicy: BEST_EFFORT_POLICY,
    /**
     * `fetch` that retries a transient failure with backoff until `policy.budgetMs` has passed, then
     * returns the last response or throws the last error, exactly as a plain `fetch` would have.
     *
     * - A connection that never opened (refused, DNS failure, unreachable, or an egress proxy that
     *   could not open its tunnel to the app) is retried for every request: the app never saw it.
     * - A failure after the request may have reached the app (a reset socket, a 502/503/504 from
     *   whatever is in front of it) is retried only when `idempotent` is set: a replay of a request
     *   that did land is a second request, not the first one taking effect later.
     * - Anything else, every 4xx and a plain 500 among them, is returned at once.
     *
     * The budget only decides whether another attempt starts; `budgetMs: 0` means no retries. The
     * first attempt may wait `attemptTimeoutMs` for its response headers, whatever the budget, so a
     * healthy slow request is never cut short by it. A retry may wait only for the lesser of that
     * and the budget left, so retrying cannot run past the budget. The body is not bounded, so a
     * download that started in time is not cut off. A caller's `init.signal` still aborts an
     * attempt, and the wait between attempts, at once.
     *
     * Goes through the global `fetch`, so the SSRF guard's undici dispatcher and socket guard still
     * see every attempt. A blocked address fails with `SSRFBlockedError` (or the egress proxy's 403),
     * which is never retried.
     */
    async fetch({ url, init, idempotent, policy = DEFAULT_POLICY }: RetryingFetchParams): Promise<Response> {
        const deadline = performance.now() + policy.budgetMs
        for (let attempt = 1; ; attempt++) {
            const timeoutMs = attempt === 1 ? policy.attemptTimeoutMs : Math.min(policy.attemptTimeoutMs, deadline - performance.now())
            const { response, error, timedOut } = await attemptOnce({ url, init, timeoutMs })
            // An attempt that got no answer in time may have landed, and it already used up what it
            // was allowed: it ends the call rather than being retried.
            if (timedOut) {
                logTimedOut({ url, method: init.method, attempt, timeoutMs })
                throw error
            }
            const failure = classifyFailure({ response, error })
            const retryable = failure === 'NOT_SENT' || (failure === 'MAYBE_SENT' && idempotent)
            const remainingMs = deadline - performance.now()
            if (!retryable || remainingMs < MIN_ATTEMPT_WINDOW_MS) {
                if (retryable) {
                    logGivingUp({ url, method: init.method, attempt, budgetMs: policy.budgetMs })
                }
                if (isNil(response)) {
                    throw error
                }
                return response
            }
            if (!isNil(response)) {
                await tryCatch(async () => response.body?.cancel())
            }
            // Half the remainder at most, so the last attempt still has time to get an answer.
            await sleep({ ms: Math.min(backoffDelayMs({ attempt, policy }), remainingMs / 2), signal: init.signal })
        }
    },
}

// Below this much budget left, another attempt could not get an answer in time anyway.
const MIN_ATTEMPT_WINDOW_MS = 50

const NOT_SENT_CODES: ReadonlySet<string> = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'ENETUNREACH',
    'ENETDOWN',
    'UND_ERR_CONNECT_TIMEOUT',
])

const MAYBE_SENT_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
])

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

// undici nests the socket error: `TypeError('fetch failed')` → `cause` with the code, and a
// multi-address connect (happy eyeballs) fails with an AggregateError whose members carry it.
const MAX_CAUSE_DEPTH = 4

// With `AP_NETWORK_MODE=STRICT` every request goes through the worker's egress proxy as a CONNECT
// tunnel (undici `ProxyAgent`, `network/proxy-dispatcher.ts`). When the proxy cannot reach the app
// it answers the CONNECT itself, and undici reports only that status, in this message, as a
// `RequestAbortedError` (`UND_ERR_ABORTED`); there is no status field to read instead. The request
// never left the proxy, so a 5xx there (proxy-chain answers 500 when the app's name does not resolve,
// 59x for its own upstream errors) is a connection that never opened. Anything else, the 403 the
// proxy sends for a blocked address above all, fails at once. A caller's own abort is a DOMException
// with no code and no such message, so it is never mistaken for this. Pinned against real undici
// and proxy-chain in `test/retrying-fetch-egress-proxy.test.ts`.
const PROXY_TUNNEL_REFUSED = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/

function classifyFailure({ response, error }: ClassifyFailureParams): Failure {
    if (!isNil(response)) {
        return RETRYABLE_STATUSES.has(response.status) ? 'MAYBE_SENT' : 'NONE'
    }
    const causes = collectCauses({ error, depth: 0 })
    if (causes.some(({ code, message }) => NOT_SENT_CODES.has(code ?? '') || isProxyTunnelServerError({ code, message }))) {
        return 'NOT_SENT'
    }
    if (causes.some(({ code }) => MAYBE_SENT_CODES.has(code ?? ''))) {
        return 'MAYBE_SENT'
    }
    return 'NONE'
}

function isProxyTunnelServerError({ code, message }: Cause): boolean {
    if (code !== 'UND_ERR_ABORTED' || isNil(message)) {
        return false
    }
    const status = PROXY_TUNNEL_REFUSED.exec(message)?.[1]
    return !isNil(status) && status.startsWith('5')
}

function collectCauses({ error, depth }: { error: unknown, depth: number }): Cause[] {
    if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || isNil(error)) {
        return []
    }
    const own: Cause = {
        code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
        message: 'message' in error && typeof error.message === 'string' ? error.message : undefined,
    }
    const fromCause = 'cause' in error ? collectCauses({ error: error.cause, depth: depth + 1 }) : []
    const fromMembers = error instanceof AggregateError
        ? error.errors.flatMap((member: unknown) => collectCauses({ error: member, depth: depth + 1 }))
        : []
    return [own, ...fromCause, ...fromMembers]
}

// The attempt's deadline is a plain timer cleared once the headers are in, not `AbortSignal.timeout`: that
// would also cut off a body still being read, and it does not run on a test's fake time.
async function attemptOnce({ url, init, timeoutMs }: AttemptOnceParams): Promise<AttemptResult> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new DOMException(`No answer from the app within ${Math.round(timeoutMs)} ms`, 'TimeoutError')), Math.max(timeoutMs, 0))
    const signal = isNil(init.signal) ? deadline.signal : AbortSignal.any([deadline.signal, init.signal])
    const { data: response, error } = await tryCatch(() => fetch(url, { ...init, signal }))
    clearTimeout(timer)
    const callerAborted = init.signal?.aborted ?? false
    return { response, error, timedOut: deadline.signal.aborted && !callerAborted }
}

// The global timer rather than `timers/promises`, so a test can run a whole 60 s budget on fake time.
function sleep({ ms, signal }: SleepParams): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(signal?.reason)
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

// Jittered, so the engines of every slot that lost the app at the same moment do not all knock on
// the restarted one in lockstep.
function backoffDelayMs({ attempt, policy }: { attempt: number, policy: RetryPolicy }): number {
    const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1))
    return exponential / 2 + Math.random() * (exponential / 2)
}

// The query string is left out of both lines on purpose: the file API carries the engine token there.
function logGivingUp({ url, method, attempt, budgetMs }: LogGivingUpParams): void {
    console.warn(`[retryingFetch] ${method ?? 'GET'} ${pathOf(url)}: still failing after ${attempt} attempts and the ${budgetMs} ms retry budget, giving up`)
}

function logTimedOut({ url, method, attempt, timeoutMs }: LogTimedOutParams): void {
    console.warn(`[retryingFetch] ${method ?? 'GET'} ${pathOf(url)}: no answer within ${Math.round(timeoutMs)} ms on attempt ${attempt}, giving up`)
}

function pathOf(url: string | URL): string {
    return new URL(url.toString()).pathname
}

export type RetryPolicy = {
    budgetMs: number
    attemptTimeoutMs: number
    initialDelayMs: number
    maxDelayMs: number
}

type RetryingFetchParams = {
    url: string | URL
    init: RequestInit
    idempotent: boolean
    policy?: RetryPolicy
}

type Failure = 'NOT_SENT' | 'MAYBE_SENT' | 'NONE'

type ClassifyFailureParams = {
    response: Response | null
    error: unknown
}

type Cause = {
    code: string | undefined
    message: string | undefined
}

type AttemptOnceParams = {
    url: string | URL
    init: RequestInit
    timeoutMs: number
}

type AttemptResult = {
    response: Response | null
    error: unknown
    timedOut: boolean
}

type SleepParams = {
    ms: number
    signal: AbortSignal | null | undefined
}

type LogTimedOutParams = {
    url: string | URL
    method: string | undefined
    attempt: number
    timeoutMs: number
}

type LogGivingUpParams = {
    url: string | URL
    method: string | undefined
    attempt: number
    budgetMs: number
}

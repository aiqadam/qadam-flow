import { isNil, tryCatch } from '@aiqadam/shared'

/**
 * How long an engine call to the app keeps retrying while the app is unreachable. It matches the
 * worker's own budget for the same outage, so a run survives an app restart on both of the legs it
 * reports through: these HTTP calls, and the RPCs the worker forwards, which wait up to
 * `READY_TIMEOUT_MS` (60 s, `packages/server/worker/src/lib/reconnect-safe-api-client.ts`) for the
 * reconnected API and are bounded by the engine's own 60 s RPC timeout to the worker
 * (`worker-socket.ts`). It is also the longest wait that cannot outlive the job: the worker trusts a
 * lease for 90 s from its last renewal and renews every 30 s (#585), so during an outage it may give
 * the job up, and kill this engine, as early as 60 s in. Before #595 this was fetch-retry's 3 retries
 * 3 s apart, about 9 s, so a routine app recreate failed every run that reached its final log upload
 * during it.
 */
const ENGINE_API_RETRY_BUDGET_MS = 60_000

const DEFAULT_POLICY: RetryPolicy = {
    budgetMs: ENGINE_API_RETRY_BUDGET_MS,
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
     * - A connection that never opened (refused, DNS failure, unreachable) is retried for every
     *   request: the app never saw it.
     * - A failure after the request may have reached the app (a reset socket, a 502/503/504 from
     *   whatever is in front of it) is retried only when `idempotent` is set, because a replay of a
     *   request that did land must not change the result.
     * - Anything else, every 4xx and a plain 500 among them, is returned at once.
     *
     * Goes through the global `fetch`, so the SSRF guard's undici dispatcher and socket guard still
     * see every attempt. A blocked address fails with `SSRFBlockedError`, which carries no socket
     * error code and is therefore never retried.
     */
    async fetch({ url, init, idempotent, policy = DEFAULT_POLICY }: RetryingFetchParams): Promise<Response> {
        const startedAt = performance.now()
        for (let attempt = 1; ; attempt++) {
            const { data: response, error } = await tryCatch(() => fetch(url, init))
            const failure = classifyFailure({ response, error })
            const retryable = failure === 'NOT_SENT' || (failure === 'MAYBE_SENT' && idempotent)
            const remainingMs = policy.budgetMs - (performance.now() - startedAt)
            if (!retryable || remainingMs <= 0) {
                if (retryable) {
                    logGivingUp({ url, method: init.method, attempt, elapsedMs: performance.now() - startedAt })
                }
                if (isNil(response)) {
                    throw error
                }
                return response
            }
            if (!isNil(response)) {
                await tryCatch(async () => response.body?.cancel())
            }
            await sleep(Math.min(backoffDelayMs({ attempt, policy }), remainingMs))
        }
    },
}

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

function classifyFailure({ response, error }: ClassifyFailureParams): Failure {
    if (!isNil(response)) {
        return RETRYABLE_STATUSES.has(response.status) ? 'MAYBE_SENT' : 'NONE'
    }
    const codes = collectErrorCodes({ error, depth: 0 })
    if (codes.some((code) => NOT_SENT_CODES.has(code))) {
        return 'NOT_SENT'
    }
    if (codes.some((code) => MAYBE_SENT_CODES.has(code))) {
        return 'MAYBE_SENT'
    }
    return 'NONE'
}

function collectErrorCodes({ error, depth }: { error: unknown, depth: number }): string[] {
    if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || isNil(error)) {
        return []
    }
    const own = 'code' in error && typeof error.code === 'string' ? [error.code] : []
    const fromCause = 'cause' in error ? collectErrorCodes({ error: error.cause, depth: depth + 1 }) : []
    const fromMembers = error instanceof AggregateError
        ? error.errors.flatMap((member: unknown) => collectErrorCodes({ error: member, depth: depth + 1 }))
        : []
    return [...own, ...fromCause, ...fromMembers]
}

// The global timer rather than `timers/promises`, so a test can run a whole 60 s budget on fake time.
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// Jittered, so the engines of every slot that lost the app at the same moment do not all knock on
// the restarted one in lockstep.
function backoffDelayMs({ attempt, policy }: { attempt: number, policy: RetryPolicy }): number {
    const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1))
    return exponential / 2 + Math.random() * (exponential / 2)
}

// The query string is left out on purpose: the file API carries the engine token there.
function logGivingUp({ url, method, attempt, elapsedMs }: LogGivingUpParams): void {
    const { pathname } = new URL(url.toString())
    console.warn(`[retryingFetch] ${method ?? 'GET'} ${pathname}: still failing after ${attempt} attempts over ${Math.round(elapsedMs)} ms, giving up`)
}

export type RetryPolicy = {
    budgetMs: number
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

type LogGivingUpParams = {
    url: string | URL
    method: string | undefined
    attempt: number
    elapsedMs: number
}

import { tryCatch, WorkerToApiContract } from '@aiqadam/shared'

/**
 * RPCs a job keeps making while it runs, and that are safe to send twice: each one either
 * overwrites state with the same value or is refused harmlessly the second time.
 * - `completeJob`: the API finishes a job only for the token that holds its lock, and the first
 *   call released it, so a duplicate is ignored before it can publish or release anything.
 * - `updateRunProgress` / `updateStepProgress`: a websocket broadcast of a snapshot.
 * - `uploadRunLog`: an upsert of the run's metadata with the same values. One exception, accepted
 *   because it needs a lost ack on the very call that ends the run: a terminal upload that landed
 *   and is sent again runs the run's finish handling again, so its alert or event can go out twice.
 * - `sendFlowResponse`: a pub/sub publish; nobody listens for an already-answered request.
 *
 * Deliberately not here: `poll` (the loop re-polls by itself), `extendLock` (every reconnect
 * renews each in-flight lease itself, and a stale renewal landing after the worker gave the job up
 * would only hold back its redelivery), and anything that creates something, such as
 * `startInlineFlowRun` or `submitPayloads`.
 */
const RECONNECT_SAFE_METHODS: ReadonlySet<string> = new Set([
    'completeJob',
    'updateRunProgress',
    'updateStepProgress',
    'uploadRunLog',
    'sendFlowResponse',
])

/** A call that loses its connection more often than this is on a link that is not coming back. */
const MAX_ATTEMPTS_ACROSS_RECONNECTS = 3

/** How long a call made while the connection is not ready waits for it: the budget the RPC itself gets. */
const READY_TIMEOUT_MS = 60_000

/**
 * socket.io rejects every acknowledgement still pending when the connection drops ("socket has
 * been disconnected"), and buffers emits made while it is down until it reconnects. So an RPC that
 * was in flight at the moment of an API restart fails, even though the same call made a second
 * later would simply wait for the reconnect and succeed. For a running job that failure is the
 * whole run: an engine whose final progress upload fails reports an internal error, and a job
 * whose `completeJob` is lost stays active until its lock expires and is then run again (#585).
 * Only the worker's side is covered: the engine gives up on its own RPC to the worker after 60 s,
 * so a run still reporting progress through an outage longer than that fails anyway.
 *
 * Retries a reconnect-safe call only when a disconnect happened while it was in flight, which is
 * read off the connection generation rather than the error text. A call that timed out on a live
 * connection is not retried: the API may be slow rather than gone, and the caller already waited
 * the full RPC timeout.
 *
 * Every call, reconnect-safe or not, is held until the connection is ready rather than left to
 * socket.io's buffer. The buffer is flushed the moment the socket connects, before the API has
 * answered the settings request that attaches its RPC handlers to the new connection, so whatever
 * was buffered reaches a socket with no listener and is never acknowledged: the caller waits out
 * the full timeout on a healthy connection, and an engine waiting on the same call fails its run.
 */
export const reconnectSafeApiClient = {
    safeMethods: RECONNECT_SAFE_METHODS,
    maxAttempts: MAX_ATTEMPTS_ACROSS_RECONNECTS,
    readyTimeoutMs: READY_TIMEOUT_MS,
    wrap({ apiClient, connection }: WrapParams): WorkerToApiContract {
        return new Proxy(apiClient, {
            get(target, property, receiver): unknown {
                const value: unknown = Reflect.get(target, property, receiver)
                if (typeof property !== 'string' || typeof value !== 'function') {
                    return value
                }
                const callWhenReady = async (input: unknown): Promise<unknown> => {
                    await waitUntilReady({ connection, method: property })
                    return Reflect.apply(value, target, [input])
                }
                if (!RECONNECT_SAFE_METHODS.has(property)) {
                    return callWhenReady
                }
                return (input: unknown) => callAcrossReconnects({
                    call: () => callWhenReady(input),
                    connection,
                    attempt: 1,
                })
            },
        })
    },
}

async function waitUntilReady({ connection, method }: WaitUntilReadyParams): Promise<void> {
    if (connection.isReady()) {
        return
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), READY_TIMEOUT_MS)
    timer.unref?.()
    await connection.whenReady({ signal: timeout.signal })
    clearTimeout(timer)
    if (!connection.isReady()) {
        throw new Error(`RPC [${method}] not sent: the connection to the API was not ready within ${READY_TIMEOUT_MS}ms`)
    }
}

async function callAcrossReconnects({ call, connection, attempt }: CallAcrossReconnectsParams): Promise<unknown> {
    const generation = connection.generation()
    const { data, error } = await tryCatch(async () => call())
    if (!error) {
        return data
    }
    const lostTheConnection = connection.generation() !== generation
    if (!lostTheConnection || attempt >= MAX_ATTEMPTS_ACROSS_RECONNECTS) {
        throw error
    }
    return callAcrossReconnects({ call, connection, attempt: attempt + 1 })
}

export type ConnectionState = {
    /** Incremented on every disconnect. */
    generation: () => number
    /** True once the API has answered this connection's settings request, which attaches its RPC handlers. */
    isReady: () => boolean
    /** Settles once ready, or once `signal` aborts; whoever aborts it checks `isReady()` after. */
    whenReady: (params: { signal: AbortSignal }) => Promise<void>
}

type WaitUntilReadyParams = {
    connection: ConnectionState
    method: string
}

type WrapParams = {
    apiClient: WorkerToApiContract
    connection: ConnectionState
}

type CallAcrossReconnectsParams = {
    call: () => unknown
    connection: ConnectionState
    attempt: number
}

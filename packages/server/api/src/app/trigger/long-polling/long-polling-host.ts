import { monitorEventLoopDelay } from 'perf_hooks'
import { QadamEventPuller, QadamEventPullOutcome } from '@aiqadam/qadams-framework'
import { AppConnection, AppConnectionStatus, ErrorCode, isNil, QadamFlowError, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { metrics } from '@opentelemetry/api'
import { Mutex } from 'async-mutex'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { appConnectionHandler } from '../../app-connection/app-connection-service/app-connection.handler'
import { distributedLock, distributedStore } from '../../database/redis-connections'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { sleep } from '../../helper/sleep'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { WebhookFlowVersionToRun, webhookService } from '../../webhooks/webhook.service'
import { eventPullerRegistry } from './event-puller-registry'
import { LongPollingSource, longPollingSourceRegistry } from './long-polling-source'

const LOCK_TTL_SECONDS = 60
const LOCK_RETRY_DELAY_MS = 15_000
const RESYNC_INTERVAL_MS = 60_000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 5 * 60_000
const CURSOR_TTL_SECONDS = 60 * 60 * 24 * 30
const SHUTDOWN_GRACE_MS = 5_000
/** Headroom over the qadam's own window, after which a call that never returns is a fatal bug. */
const PULLER_GRACE_SECONDS = 30
/**
 * Floor between the starts of two windows. A well-behaved puller holds its socket open for
 * `windowSeconds` and never comes near this; one that returns instantly — a misconfigured endpoint
 * answering immediately, say — would otherwise spin this loop at full speed inside the process that
 * serves user requests. The host runs qadam code unsandboxed, so it owns this guard.
 */
const MIN_WINDOW_INTERVAL_MS = 250

const tasks = new Map<string, RunningTask>()
const fatalSources = new Map<string, FatalSource>()
const syncMutex = new Mutex()
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
let resyncTimer: NodeJS.Timeout | undefined
let metricsRegistered = false
let started = false

export const longPollingHost = (log: FastifyBaseLogger) => ({
    async start(): Promise<void> {
        if (started || !isEnabled()) {
            return
        }
        await eventPullerRegistry.load()
        started = true
        registerMetrics()
        eventLoopDelay.enable()
        await sync(log)
        resyncTimer = setInterval(() => rejectedPromiseHandler(sync(log), log), RESYNC_INTERVAL_MS)
        resyncTimer.unref()
        log.info('[longPollingHost#start] Long-polling host started')
    },
    /**
     * Refuses to enable a trigger that asks for the pull transport while the host is switched off.
     * Without this the qadam's `onEnable` removes the webhook and nothing replaces it, so the flow
     * ends up with no delivery at all — worse than before the user touched it, and silent.
     */
    async assertTransportIsAvailable({ qadamName, config }: AssertTransportParams): Promise<void> {
        if (isEnabled() || !eventPullerRegistry.isRegistered(qadamName)) {
            return
        }
        const puller = await eventPullerRegistry.getOrLoad(qadamName)
        if (isNil(puller) || !(tryCatchSync(() => puller.isEnabledFor({ config })).data ?? false)) {
            return
        }
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: LONG_POLLING_DISABLED_MESSAGE },
        }, LONG_POLLING_DISABLED_MESSAGE)
    },
    /**
     * Called from the trigger side effects so enabling or disabling a flow takes effect at once
     * instead of waiting for the next resync. Deliberately fire-and-forget: a mutation must never
     * fail because the host could not be reconciled.
     */
    requestSync(): void {
        if (!started) {
            return
        }
        rejectedPromiseHandler(sync(log), log)
    },
    /**
     * Takes the same mutex as `sync`, so a reconciliation that is mid-query when shutdown begins
     * cannot spawn tasks into a map nobody will read again — those would keep the event loop alive
     * past SIGTERM, polling against connections the app has already torn down.
     */
    async stop(): Promise<void> {
        await syncMutex.runExclusive(async () => {
            if (!started) {
                return
            }
            started = false
            if (!isNil(resyncTimer)) {
                clearInterval(resyncTimer)
                resyncTimer = undefined
            }
            eventLoopDelay.disable()
            const running = Array.from(tasks.values())
            tasks.clear()
            fatalSources.clear()
            running.forEach((task) => task.abortController.abort())
            await Promise.race([
                Promise.allSettled(running.map((task) => task.promise)),
                sleep(SHUTDOWN_GRACE_MS),
            ])
            log.info('[longPollingHost#stop] Long-polling host stopped')
        })
    },
})

async function sync(log: FastifyBaseLogger): Promise<void> {
    await syncMutex.runExclusive(async () => {
        // `stop()` takes this same mutex, so a reconciliation either finishes before shutdown
        // begins — and has its tasks aborted by it — or observes `started === false` here and
        // spawns nothing. Neither order leaves a task whose abort controller nobody holds.
        if (!started) {
            return
        }
        const { data: sources, error } = await tryCatch(() => longPollingSourceRegistry(log).list())
        if (error !== null) {
            log.error({ err: error }, '[longPollingHost#sync] Could not read the long-polling registry')
            return
        }
        const desired = new Map(sources.map((source) => [source.key, source]))

        for (const [key, task] of tasks) {
            const next = desired.get(key)
            if (isNil(next) || next.triggerSourceId !== task.source.triggerSourceId) {
                task.abortController.abort()
                tasks.delete(key)
            }
        }
        // Keyed on the trigger-source row rather than the flow version, so disabling and re-enabling
        // a flow clears the mark even when the flow was not republished — that is what a user
        // actually does to recover, and `enable` always writes a new row.
        for (const [key, fatal] of fatalSources) {
            if (desired.get(key)?.triggerSourceId !== fatal.triggerSourceId) {
                fatalSources.delete(key)
            }
        }
        for (const source of desired.values()) {
            if (tasks.has(source.key) || fatalSources.has(source.key)) {
                continue
            }
            const abortController = new AbortController()
            const promise = runTask({ source, hostSignal: abortController.signal, log })
            tasks.set(source.key, { source, abortController, promise })
            log.info({ key: source.key, flowId: source.flowId }, '[longPollingHost#sync] Started long-polling task')
        }
    })
}

/**
 * Resolves the credential, then holds the cluster-wide singleton for it as long as it can, and
 * re-queues when it loses it. Two instances polling one cursor would silently steal each other's
 * updates — and so would two *connections* holding one bot token, which is why the lock is keyed on
 * the puller's credential key rather than on the connection.
 */
async function runTask({ source, hostSignal, log }: RunTaskParams): Promise<void> {
    const puller = eventPullerRegistry.get(source.qadamName)
    if (isNil(puller)) {
        tasks.delete(source.key)
        return
    }
    let backoffMs = 0

    while (!hostSignal.aborted) {
        if (backoffMs > 0 && !await sleepUntilAborted({ ms: backoffMs, signal: hostSignal })) {
            return
        }
        const credential = await resolveCredential({ source, puller, log })
        if (credential.status === CredentialStatus.GONE) {
            markFatal({ source, reason: credential.reason, log })
            return
        }
        if (credential.status === CredentialStatus.UNAVAILABLE) {
            // A failover or a lock timeout is not a missing connection. Treating it as fatal here is
            // how a three-second database wobble would silence every bot on the instance at once.
            backoffMs = nextBackoff({ backoffMs })
            log.warn({
                key: source.key,
                reason: credential.reason,
                backoffMs,
            }, '[longPollingHost#runTask] Could not read the connection, retrying')
            continue
        }

        const { data: done, error } = await tryCatch(() => distributedLock(log).runExclusive({
            key: `long-polling:${source.qadamName}|${credential.credentialKey}`,
            timeoutInSeconds: LOCK_TTL_SECONDS,
            fn: (lockLostSignal) => pollUntilDone({
                source,
                puller,
                credential,
                hostSignal,
                lockLostSignal,
                log,
            }),
        }))
        if (error === null && done) {
            return
        }
        if (error !== null) {
            log.warn({
                key: source.key,
                err: error,
            }, '[longPollingHost#runTask] Could not hold the lock for this credential, re-queueing')
        }
        backoffMs = 0
        await sleepUntilAborted({ ms: LOCK_RETRY_DELAY_MS, signal: hostSignal })
    }
}

async function pollUntilDone({ source, puller, credential, hostSignal, lockLostSignal, log }: PollUntilDoneParams): Promise<boolean> {
    // An own controller rather than AbortSignal.any, so leaving this function for any reason —
    // fatal, timeout, shutdown — also cancels whatever request the qadam still has open.
    const pullController = new AbortController()
    const abortPull = () => pullController.abort()
    hostSignal.addEventListener('abort', abortPull, { once: true })
    lockLostSignal.addEventListener('abort', abortPull, { once: true })
    // A listener added to an already-aborted signal never fires, and shutdown can land in the gap
    // between acquiring the lock and getting here — which would leave this loop running forever
    // with nobody holding a reference to it.
    if (hostSignal.aborted || lockLostSignal.aborted) {
        abortPull()
    }
    try {
        await pollLoop({ source, puller, credential, signal: pullController.signal, log })
        // Anything else — a lost lock — means the credential is still wanted, so the caller should
        // queue for the lock again rather than give the source up.
        return hostSignal.aborted || fatalSources.has(source.key)
    }
    finally {
        hostSignal.removeEventListener('abort', abortPull)
        lockLostSignal.removeEventListener('abort', abortPull)
        pullController.abort()
    }
}

/** Returns when the window should stop being reopened — the signal fired, or the source is fatal. */
async function pollLoop({ source, puller, credential: acquiredWith, signal, log }: PollLoopParams): Promise<void> {
    const timeoutMs = (puller.windowSeconds + PULLER_GRACE_SECONDS) * 1000
    let backoffMs = 0
    // The caller resolved this to key the lock; reusing it saves one decrypt on the first window.
    let credential: ResolvedCredential = acquiredWith

    while (!signal.aborted) {
        if (backoffMs > 0 && !await sleepUntilAborted({ ms: backoffMs, signal })) {
            return
        }
        if (credential.status === CredentialStatus.GONE) {
            markFatal({ source, reason: credential.reason, log })
            return
        }
        if (credential.status === CredentialStatus.UNAVAILABLE) {
            backoffMs = nextBackoff({ backoffMs })
            log.warn({
                key: source.key,
                reason: credential.reason,
                backoffMs,
            }, '[longPollingHost#pollLoop] Could not read the connection, retrying')
            // Re-read on the next pass rather than cached, so a rotated token takes effect at once.
            credential = await resolveCredential({ source, puller, log })
            continue
        }
        const resolved: ResolvedCredentialValue = credential
        if (resolved.credentialKey !== acquiredWith.credentialKey) {
            // The connection now points at a different credential, so this is the wrong lock to be
            // holding. Returning sends the caller back to acquire under the new key.
            log.info({ key: source.key }, '[longPollingHost#pollLoop] Credential changed, re-acquiring the lock')
            return
        }

        const cursor = await readCursor(resolved.credentialKey)

        // Qadam code runs here in-process, unsandboxed: it is handed nothing but its own auth, the
        // trigger's own settings and a signal, it is time-boxed, and a throw kills this one task.
        const windowStartedAt = Date.now()
        const { data: result, error } = await tryCatch(() => withTimeout({
            promise: puller.waitForEvents({ auth: resolved.auth, config: source.config, cursor, signal }),
            timeoutMs,
        }))
        if (error !== null) {
            markFatal({ source, reason: `The puller failed or overran its window: ${error.message}`, log })
            return
        }

        switch (result?.outcome) {
            case QadamEventPullOutcome.EVENTS: {
                const delivered = await deliverEvents({ source, events: result.events, log })
                if (!delivered) {
                    backoffMs = nextBackoff({ backoffMs })
                    break
                }
                if (signal.aborted) {
                    // The lock went while we were delivering; whoever holds it now owns the cursor.
                    return
                }
                // Only now, so an event survives the process dying between fetch and delivery.
                await writeCursor({ credentialKey: resolved.credentialKey, cursor: result.nextCursor })
                backoffMs = 0
                break
            }
            case QadamEventPullOutcome.RETRYABLE: {
                backoffMs = nextBackoff({ backoffMs, retryAfterSeconds: result.retryAfterSeconds })
                log.warn({
                    key: source.key,
                    reason: result.reason,
                    backoffMs,
                }, '[longPollingHost#pollLoop] Retryable pull failure')
                break
            }
            case QadamEventPullOutcome.FATAL: {
                markFatal({ source, reason: result.reason, log })
                return
            }
            default: {
                markFatal({ source, reason: 'The puller returned a result the host does not understand', log })
                return
            }
        }
        const elapsedMs = Date.now() - windowStartedAt
        if (elapsedMs < MIN_WINDOW_INTERVAL_MS && !await sleepUntilAborted({ ms: MIN_WINDOW_INTERVAL_MS - elapsedMs, signal })) {
            return
        }
        credential = await resolveCredential({ source, puller, log })
    }
}

async function resolveCredential({ source, puller, log }: ResolveCredentialParams): Promise<ResolvedCredential> {
    const { data: connection, error } = await tryCatch(() => appConnectionHandler(log).lockAndRefreshConnection({
        projectId: source.projectId,
        externalId: source.connectionExternalId,
        log,
    }))
    if (error !== null) {
        return { status: CredentialStatus.UNAVAILABLE, reason: error.message }
    }
    if (isNil(connection)) {
        return { status: CredentialStatus.GONE, reason: 'The connection backing this trigger no longer exists' }
    }
    if (connection.status === AppConnectionStatus.ERROR) {
        return { status: CredentialStatus.GONE, reason: 'The connection backing this trigger is in error' }
    }
    if (connection.qadamName !== source.qadamName) {
        return {
            status: CredentialStatus.GONE,
            reason: `The trigger points at a ${connection.qadamName} connection, which this puller must not be handed`,
        }
    }
    const { data: credentialKey, error: credentialKeyError } = tryCatchSync(() => puller.credentialKey({ auth: connection.value }))
    if (credentialKeyError !== null) {
        return { status: CredentialStatus.GONE, reason: `The puller threw while identifying the credential: ${credentialKeyError.message}` }
    }
    if (isNil(credentialKey)) {
        return { status: CredentialStatus.GONE, reason: 'The puller does not recognise the value stored in this connection' }
    }
    return {
        status: CredentialStatus.RESOLVED,
        auth: connection.value,
        credentialKey,
    }
}

async function deliverEvents({ source, events, log }: DeliverEventsParams): Promise<boolean> {
    for (const event of events) {
        const { data: response, error } = await tryCatch(() => webhookService.handleWebhook({
            logger: log,
            flowId: source.flowId,
            async: true,
            saveSampleData: false,
            flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
            execute: true,
            failParentOnFailure: false,
            data: async () => ({
                body: event,
                rawBody: event,
                method: 'POST',
                headers: {},
                queryParams: {},
            }),
        }))
        if (error !== null) {
            log.error({ err: error, key: source.key }, '[longPollingHost#deliverEvents] Delivery failed, the cursor stays put')
            return false
        }
        if (response.status === StatusCodes.GONE) {
            // The flow is gone; redelivering would loop forever, and the next resync drops the task.
            log.warn({ key: source.key, flowId: source.flowId }, '[longPollingHost#deliverEvents] Dropped an update for a flow that no longer exists')
        }
    }
    return true
}

function markFatal({ source, reason, log }: MarkFatalParams): void {
    fatalSources.set(source.key, { triggerSourceId: source.triggerSourceId, reason })
    // Guarded, so a fatal verdict from a task a resync has already replaced cannot evict its
    // successor and leave it running with nobody holding its abort controller.
    if (tasks.get(source.key)?.source.triggerSourceId === source.triggerSourceId) {
        tasks.delete(source.key)
    }
    log.error({
        key: source.key,
        flowId: source.flowId,
        projectId: source.projectId,
        reason,
    }, '[longPollingHost#markFatal] Long-polling task stopped; disable and re-enable the flow to retry')
}

/**
 * `retryAfterSeconds` is a floor the third party asked for, so it is applied after the ceiling —
 * capping it would only earn another rate-limit response.
 */
function nextBackoff({ backoffMs, retryAfterSeconds }: NextBackoffParams): number {
    const capped = Math.min(Math.max(MIN_BACKOFF_MS, backoffMs * 2), MAX_BACKOFF_MS)
    const requested = isNil(retryAfterSeconds) ? 0 : retryAfterSeconds * 1000
    return Math.max(capped, requested)
}

async function readCursor(credentialKey: string): Promise<string | undefined> {
    return await distributedStore.get<string>(cursorKey(credentialKey)) ?? undefined
}

async function writeCursor({ credentialKey, cursor }: WriteCursorParams): Promise<void> {
    if (isNil(cursor)) {
        return
    }
    await distributedStore.put(cursorKey(credentialKey), cursor, CURSOR_TTL_SECONDS)
}

function cursorKey(credentialKey: string): string {
    return `long-polling:cursor:${credentialKey}`
}

async function withTimeout<T>({ promise, timeoutMs }: WithTimeoutParams<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
            }),
        ])
    }
    finally {
        if (!isNil(timer)) {
            clearTimeout(timer)
        }
    }
}

async function sleepUntilAborted({ ms, signal }: SleepUntilAbortedParams): Promise<boolean> {
    if (signal.aborted) {
        return false
    }
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer)
            resolve(false)
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve(true)
        }, ms)
        // Unref'd so a pending backoff cannot hold the process open past SIGTERM.
        timer.unref()
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

function isEnabled(): boolean {
    return system.getBoolean(AppSystemProp.TRIGGER_LONG_POLLING_ENABLED) ?? false
}

/**
 * The open question about this design is whether long-lived outbound sockets disturb the process
 * that serves user requests. These two numbers are what makes that answerable instead of guessed.
 */
function registerMetrics(): void {
    if (metricsRegistered) {
        return
    }
    metricsRegistered = true
    const meter = metrics.getMeter('long-polling-host')
    meter.createObservableGauge('qadam_flow.long_polling.tasks', {
        description: 'Long-polling tasks this instance is currently running',
    }).addCallback((result) => result.observe(tasks.size))
    meter.createObservableGauge('qadam_flow.long_polling.event_loop_delay_ms', {
        description: 'Mean event-loop delay since the previous observation',
        unit: 'ms',
    }).addCallback((result) => {
        result.observe(eventLoopDelay.mean / 1e6)
        eventLoopDelay.reset()
    })
}

enum CredentialStatus {
    RESOLVED = 'RESOLVED',
    /** The connection is missing, broken, or not this qadam's — retrying cannot help. */
    GONE = 'GONE',
    /** We could not read it right now. Says nothing about whether it exists. */
    UNAVAILABLE = 'UNAVAILABLE',
}

type ResolvedCredentialValue = {
    status: CredentialStatus.RESOLVED
    auth: AppConnection['value']
    credentialKey: string
}

type ResolvedCredential =
    | ResolvedCredentialValue
    | { status: CredentialStatus.GONE, reason: string }
    | { status: CredentialStatus.UNAVAILABLE, reason: string }

type RunningTask = {
    source: LongPollingSource
    abortController: AbortController
    promise: Promise<void>
}

type FatalSource = {
    triggerSourceId: string
    reason: string
}

type RunTaskParams = {
    source: LongPollingSource
    hostSignal: AbortSignal
    log: FastifyBaseLogger
}

type PollUntilDoneParams = RunTaskParams & {
    puller: QadamEventPuller
    credential: ResolvedCredentialValue
    lockLostSignal: AbortSignal
}

type PollLoopParams = {
    source: LongPollingSource
    puller: QadamEventPuller
    credential: ResolvedCredentialValue
    signal: AbortSignal
    log: FastifyBaseLogger
}

type ResolveCredentialParams = {
    source: LongPollingSource
    puller: QadamEventPuller
    log: FastifyBaseLogger
}

type DeliverEventsParams = {
    source: LongPollingSource
    events: unknown[]
    log: FastifyBaseLogger
}

type MarkFatalParams = {
    source: LongPollingSource
    reason: string
    log: FastifyBaseLogger
}

type NextBackoffParams = {
    backoffMs: number
    retryAfterSeconds?: number
}

type WriteCursorParams = {
    credentialKey: string
    cursor: string | undefined
}

type WithTimeoutParams<T> = {
    promise: Promise<T>
    timeoutMs: number
}

type SleepUntilAbortedParams = {
    ms: number
    signal: AbortSignal
}

const LONG_POLLING_DISABLED_MESSAGE = 'This trigger is set to long polling, which requires AP_TRIGGER_LONG_POLLING_ENABLED=true on the server. Enable it, or switch the trigger back to webhook delivery.'

type AssertTransportParams = {
    qadamName: string
    config: unknown
}

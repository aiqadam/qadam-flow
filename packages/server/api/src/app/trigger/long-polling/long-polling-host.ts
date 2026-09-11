import { monitorEventLoopDelay } from 'perf_hooks'
import { QadamEventPuller, QadamEventPullOutcome } from '@aiqadam/qadams-framework'
import { AppConnectionStatus, isNil, tryCatch } from '@aiqadam/shared'
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
        started = true
        registerMetrics()
        eventLoopDelay.enable()
        await sync(log)
        resyncTimer = setInterval(() => rejectedPromiseHandler(sync(log), log), RESYNC_INTERVAL_MS)
        resyncTimer.unref()
        log.info('[longPollingHost#start] Long-polling host started')
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
    async stop(): Promise<void> {
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
    },
})

async function sync(log: FastifyBaseLogger): Promise<void> {
    await syncMutex.runExclusive(async () => {
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
            if (isNil(next) || next.flowVersionId !== task.source.flowVersionId) {
                task.abortController.abort()
                tasks.delete(key)
            }
        }
        // A republish is the only signal that a fatal condition may have been fixed, so a fatal
        // mark survives until the source is pointing at a different flow version.
        for (const [key, fatal] of fatalSources) {
            if (desired.get(key)?.flowVersionId !== fatal.flowVersionId) {
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
 * Holds the cluster-wide singleton for this credential for as long as it can, and re-queues for it
 * when it loses it. Two instances polling one cursor would silently steal each other's updates.
 */
async function runTask({ source, hostSignal, log }: RunTaskParams): Promise<void> {
    while (!hostSignal.aborted) {
        const { data: done, error } = await tryCatch(() => distributedLock(log).runExclusive({
            key: `long-polling:${source.key}`,
            timeoutInSeconds: LOCK_TTL_SECONDS,
            fn: (lockLostSignal) => pollUntilDone({ source, hostSignal, lockLostSignal, log }),
        }))
        if (isNil(error) && done) {
            return
        }
        if (error !== null) {
            log.debug({ key: source.key, err: error }, '[longPollingHost#runTask] Another instance holds this credential')
        }
        await sleepUntilAborted({ ms: LOCK_RETRY_DELAY_MS, signal: hostSignal })
    }
}

async function pollUntilDone({ source, hostSignal, lockLostSignal, log }: PollUntilDoneParams): Promise<boolean> {
    const puller = eventPullerRegistry.get(source.qadamName)
    if (isNil(puller)) {
        return true
    }
    // An own controller rather than AbortSignal.any, so leaving this function for any reason —
    // fatal, timeout, shutdown — also cancels whatever request the qadam still has open.
    const pullController = new AbortController()
    const abortPull = () => pullController.abort()
    hostSignal.addEventListener('abort', abortPull, { once: true })
    lockLostSignal.addEventListener('abort', abortPull, { once: true })
    try {
        await pollLoop({ source, puller, signal: pullController.signal, log })
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
async function pollLoop({ source, puller, signal, log }: PollLoopParams): Promise<void> {
    const timeoutMs = (puller.windowSeconds + PULLER_GRACE_SECONDS) * 1000
    let backoffMs = 0

    while (!signal.aborted) {
        if (backoffMs > 0 && !await sleepUntilAborted({ ms: backoffMs, signal })) {
            return
        }
        const auth = await resolveAuth({ source, log })
        if (isNil(auth)) {
            markFatal({ source, reason: 'The connection backing this trigger is missing or in error', log })
            return
        }
        const cursor = await readCursor(source.key)

        // Qadam code runs here in-process, unsandboxed: it is handed nothing but its own auth,
        // cursor and signal, it is time-boxed, and a throw kills this one task and nothing else.
        const { data: result, error } = await tryCatch(() => withTimeout({
            promise: puller.waitForEvents({ auth, config: source.config, cursor, signal }),
            timeoutMs,
        }))
        if (error !== null) {
            markFatal({ source, reason: `The puller failed or overran its window: ${error.message}`, log })
            return
        }

        switch (result.outcome) {
            case QadamEventPullOutcome.EVENTS: {
                const delivered = await deliverEvents({ source, events: result.events, log })
                if (!delivered) {
                    backoffMs = nextBackoff({ backoffMs })
                    break
                }
                // Only now, so an event survives the process dying between fetch and delivery.
                await writeCursor({ key: source.key, cursor: result.nextCursor })
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
        }
    }
}

async function resolveAuth({ source, log }: ResolveAuthParams): Promise<unknown> {
    // Re-read every window rather than caching: a rotated token must take effect without a resync.
    const { data: connection, error } = await tryCatch(() => appConnectionHandler(log).lockAndRefreshConnection({
        projectId: source.projectId,
        externalId: source.connectionExternalId,
        log,
    }))
    if (error !== null) {
        log.error({ err: error, key: source.key }, '[longPollingHost#resolveAuth] Could not read the connection')
        return null
    }
    if (isNil(connection) || connection.status === AppConnectionStatus.ERROR) {
        return null
    }
    return connection.value
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
    fatalSources.set(source.key, { flowVersionId: source.flowVersionId, reason })
    tasks.delete(source.key)
    log.error({
        key: source.key,
        flowId: source.flowId,
        projectId: source.projectId,
        reason,
    }, '[longPollingHost#markFatal] Long-polling task stopped and will not retry until the flow is republished')
}

function nextBackoff({ backoffMs, retryAfterSeconds }: NextBackoffParams): number {
    const requested = isNil(retryAfterSeconds) ? 0 : retryAfterSeconds * 1000
    return Math.min(Math.max(MIN_BACKOFF_MS, backoffMs * 2, requested), MAX_BACKOFF_MS)
}

async function readCursor(key: string): Promise<string | undefined> {
    return await distributedStore.get<string>(cursorKey(key)) ?? undefined
}

async function writeCursor({ key, cursor }: WriteCursorParams): Promise<void> {
    if (isNil(cursor)) {
        return
    }
    await distributedStore.put(cursorKey(key), cursor, CURSOR_TTL_SECONDS)
}

function cursorKey(key: string): string {
    return `long-polling:cursor:${key}`
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

type RunningTask = {
    source: LongPollingSource
    abortController: AbortController
    promise: Promise<void>
}

type FatalSource = {
    flowVersionId: string
    reason: string
}

type RunTaskParams = {
    source: LongPollingSource
    hostSignal: AbortSignal
    log: FastifyBaseLogger
}

type PollUntilDoneParams = RunTaskParams & {
    lockLostSignal: AbortSignal
}

type PollLoopParams = {
    source: LongPollingSource
    puller: QadamEventPuller
    signal: AbortSignal
    log: FastifyBaseLogger
}

type ResolveAuthParams = {
    source: LongPollingSource
    log: FastifyBaseLogger
}

type DeliverEventsParams = ResolveAuthParams & {
    events: unknown[]
}

type MarkFatalParams = ResolveAuthParams & {
    reason: string
}

type NextBackoffParams = {
    backoffMs: number
    retryAfterSeconds?: number
}

type WriteCursorParams = {
    key: string
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

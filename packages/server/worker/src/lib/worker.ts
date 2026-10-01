import { createServer } from 'http'
import { setMaxListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import os from 'os'
import { apVersionUtil, systemUsage } from '@aiqadam/server-utils'
import {
    ConsumeJobRequest,
    createRpcClient,
    EngineResponseStatus,
    ExecutionMode,
    isNil,
    JobData,
    QadamFlowError,
    SandboxInformation,
    tryCatch,
    tryCatchSync,
    WebsocketServerEvent,
    WorkerJobType,
    WorkerMachineHealthcheckRequest,
    WorkerProps,
    WorkerSettingsResponse,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { trace } from '@opentelemetry/api'
import { nanoid } from 'nanoid'
import type { Logger } from 'pino'
import { io, Socket } from 'socket.io-client'
import { qadamInstaller } from './cache/qadams/qadam-installer'
import { getApiUrl, system, WorkerSystemProp } from './config/configs'
import { logger } from './config/logger'
import { workerSettings } from './config/worker-settings'
import { EgressStack, startEgressStack } from './egress/lifecycle'
import { givenUpGuard } from './execute/given-up-guard'
import { ClassifiedJobFailure } from './execute/job-failure'
import { getHandler } from './execute/job-registry'
import { JobTimings, jobTimings } from './execute/job-timings'
import { ActiveSandboxInfo, createSandboxManager, SandboxManager } from './execute/sandbox-manager'
import { JobContext, JobResult, JobResultKind } from './execute/types'
import { leaseTracker } from './lease-tracker'
import { reconnectSafeApiClient } from './reconnect-safe-api-client'


const tracer = trace.getTracer('worker')

const AP_VERSION = apVersionUtil.getCurrentRelease()

// Exported so the skew test can assert this stays well under the registry TTL — a version-skewed
// worker is kept in the registry only by the heartbeat on this interval (#222).
export const VERSION_MISMATCH_POLL_PAUSE_MS = 10_000

/** The server hangs up before it finishes restarting, so the first retry has to arrive after it. */
const MANUAL_RECONNECT_DELAY_MS = 2_000

/** A poll loop that crashed is started again after this, so a persistent fault does not spin. */
const POLL_LOOP_RESTART_DELAY_MS = 1_000

const DRAIN_CHECK_INTERVAL_MS = 100

/**
 * socket.io reconnects by itself after a transport-level drop, but **not** when the server closed
 * the connection: `io server disconnect` is documented as requiring a manual `connect()`. A
 * graceful API shutdown is exactly that reason.
 *
 * Without a manual reconnect, every API restart leaves every worker permanently idle — the pollers
 * exit on the generation change, `connect` never fires again to start new ones, and the only trace
 * is one "Disconnected" line and a handful of "Poll failed" before silence. Jobs then queue up
 * behind a worker that is running, connected to nothing, and reporting nothing.
 *
 * `io client disconnect` is our own `stop()` and must never be reconnected.
 */
export function needsManualReconnect(reason: string): boolean {
    return reason === 'io server disconnect'
}

let socket: Socket | null = null
/** Incremented on every disconnect, so a caller can tell whether its call spanned one. */
let connectionGeneration = 0
let stopped = false
/**
 * Set once `stop()` has drained and is about to close the socket. Distinct from `stopped`: a
 * worker that is draining still reconnects after an API restart, because its jobs can only report
 * completion over a live socket.
 */
let closing = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** Whether the last disconnect was one socket.io will not retry on its own. */
let reconnectIsOurs = false

const workerId = `worker-${nanoid()}`

const workerHostname = os.hostname()

let healthServerInstance: ReturnType<typeof createServer> | null = null

let egressStack: EgressStack | null = null

let sandboxManagers: SandboxManager[] = []

let activePollLoops = 0

/**
 * Jobs between being handed out by a poll and their `completeJob`, keyed by lease token: what a stop
 * has to drain, and whose leases a reconnect re-checks.
 */
const inFlightJobs = new Map<string, InFlightJob>()

/** Each in-flight job's lease, and the deadline that gives it up once it is not renewed in time. */
const leases = leaseTracker.create({
    onExpired: ({ token, leaseAgeMs }) => {
        void abandonLostLease({ token, reason: 'not renewed in time', leaseAgeMs })
    },
})

/** The settings the current sandboxes were built with, so any later connect can tell they are out of date. */
let sandboxSettings: WorkerSettingsResponse | null = null

/**
 * Open while the socket is connected and this connection's settings are loaded. The poll loops wait
 * on it instead of exiting on a disconnect: they, their sandbox managers and any job they are
 * running outlive a reconnect (#585).
 */
const connectionGate = createConnectionGate()

/**
 * Aborted by `stop()`. The poll loops park inside a long-poll whose server-side budget is
 * WAITER_TIMEOUT_MS (50s) and whose client-side RPC timeout is 60s, and they only re-read
 * `stopped` at the head of the `while` — so without something to interrupt the await, "stop
 * polling" means "stop polling in up to a minute".
 */
let stopController = new AbortController()

/** The loops `startPollingWorkers` launched, so `stop()` has something to wait for. */
let pollingWorkers: Promise<void> | null = null

/** Node's own default; kept as headroom so a genuine listener leak still trips the warning. */
const DEFAULT_MAX_LISTENERS = 10

export const worker = {
    async start({ apiUrl, socketUrl, workerToken, withHealthServer = false }: WorkerStartParams): Promise<void> {
        // Reset, so a worker started again after `stop()` can still reconnect.
        stopped = false
        closing = false
        stopController = new AbortController()
        // The worker group is not sent in the handshake any more: the API reads it from the
        // verified token principal, so a value asserted here would be ignored. AP_WORKER_GROUP_ID
        // still gates the local sandbox-mode checks below, but it no longer selects a group (#207).
        socket = io(socketUrl.url, {
            auth: { token: workerToken, workerId },
            path: socketUrl.path,
            transports: ['websocket'],
            reconnection: true,
        })

        const apiClient = reconnectSafeApiClient.wrap({
            apiClient: createRpcClient<WorkerToApiContract>(socket, 60_000),
            connection: {
                generation: () => connectionGeneration,
                isReady: () => connectionGate.isOpen(),
                whenReady: ({ signal }) => connectionGate.whenOpen({ signal }),
            },
        })

        socket.on('connect', async () => {
            // The reconnect this flag described is done; a later `connect_error` belongs to
            // whatever disconnect comes after it, not to this one.
            reconnectIsOurs = false
            const generation = connectionGeneration
            logger.info('Connected to API server via Socket.IO')
            await fetchAndStoreSettings(socket!)
            if (!egressStack) {
                const { data, error } = await tryCatch(() => startEgressStack({ log: logger, apiUrl }))
                if (error) {
                    // Kill switch: if SSRF hardening can't be applied, refuse to accept any job.
                    // Running without egress protection in a configured-hardened worker is
                    // more dangerous than crash-looping — the orchestrator will restart us.
                    logger.fatal({ err: error }, 'Egress stack failed to start; aborting worker to avoid running unprotected')
                    process.exit(1)
                }
                egressStack = data
            }
            // Disconnected again while the settings were in flight: the gate is the next connect's.
            if (generation !== connectionGeneration || socket?.connected !== true) {
                return
            }
            if (sandboxManagers.length > 0) {
                recycleSandboxesIfSettingsChanged()
                reconfirmLeases({ apiClient })
                logger.info({ inFlightJobs: inFlightJobs.size }, 'Reconnected: in-flight jobs keep running, polling resumes')
            }
            connectionGate.open()
            // A draining worker reconnects only so its jobs can finish; it takes no new work.
            if (stopped) {
                return
            }
            void warmupPiecesOnStartup(apiClient)
            if (isNil(pollingWorkers)) {
                pollingWorkers = launchPollingWorkers(apiClient)
            }
        })

        socket.on('disconnect', (reason) => {
            connectionGeneration++
            connectionGate.close()
            reconnectIsOurs = needsManualReconnect(reason)
            logger.warn({ reason }, 'Disconnected from API server')
            if (reconnectIsOurs) {
                scheduleReconnect()
            }
        })

        socket.on('connect_error', (error) => {
            logger.error({ error: error.message }, 'Socket.IO connection error')
            // Only when the reconnect is ours to drive. socket.io raises this during its own
            // automatic retry and on a failed first boot as well, and rescheduling there would lay
            // a fixed 2s cadence over the backoff it is already running.
            if (reconnectIsOurs) {
                // A manual reconnect that lands while the API is still restarting fails here. Keep
                // trying, or the first attempt after a slow restart is also the last.
                scheduleReconnect()
            }
        })

        if (withHealthServer) {
            healthServerInstance = startHealthServer()
        }
        logger.info({ apiUrl, socketUrl, shutdownGraceMs: system.getShutdownGraceMs() }, 'Worker started, polling for jobs...')
    },

    async stop(): Promise<void> {
        stopped = true
        stopController.abort()
        pollingWorkers = null
        const inFlightJobsAtStop = inFlightJobs.size
        const graceMs = system.getShutdownGraceMs()
        if (inFlightJobsAtStop > 0) {
            logger.info({ inFlightJobs: inFlightJobsAtStop, graceMs }, 'Stopping: no new jobs taken, waiting for in-flight jobs to finish')
        }
        // Before the sandbox managers go: a loop still running is a loop that can still be handed
        // a job, and it would run it against managers this call has already shut down and dropped.
        // The socket stays up meanwhile, so a draining job can still report progress and complete.
        await awaitDrain({ graceMs })
        const abandonedJobs = inFlightJobs.size
        if (abandonedJobs > 0) {
            logger.warn({ abandonedJobs, graceMs }, 'Shutdown grace expired, abandoning in-flight jobs')
            // They cannot report back over the socket that closes below. Marked before their engines
            // are killed, so none of them sends anything more (no completeJob, no terminal status,
            // no log) and each loop unwinds once its engine is gone. A call already in flight fails
            // when the socket closes. The API redelivers each job when its lock expires.
            inFlightJobs.forEach((inFlight, token) => {
                inFlightJobs.set(token, { ...inFlight, givenUp: 'shutdown' })
            })
        }
        closing = true
        reconnectIsOurs = false
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }
        await Promise.all(sandboxManagers.map((sm) => sm.shutdown(logger)))
        sandboxManagers = []
        sandboxSettings = null
        connectionGate.close()
        socket?.disconnect()
        socket = null
        healthServerInstance?.close()
        healthServerInstance = null
        if (egressStack) {
            await egressStack.shutdown()
            egressStack = null
        }
        logger.info({ inFlightJobsAtStop, abandonedJobs }, 'Worker stopped')
    },
}

/**
 * Read-only introspection for the shutdown test. `stop()`'s postcondition is that no poll loop is
 * still running, and that is not observable from outside the module — the loops are launched as
 * `void startPollingWorkers(...)` and nothing holds them. Nothing in production reads this.
 */
export const workerInternals = {
    activePollLoopCount: (): number => activePollLoops,
}

/**
 * Waits until no job is in flight and no poll loop is running, but never longer than the grace:
 * `stop()` must not hang on a job that never ends. Read off the counters rather than the loops'
 * promise, so a job whose loop is gone is still waited for.
 */
async function awaitDrain({ graceMs }: { graceMs: number }): Promise<void> {
    const deadline = Date.now() + graceMs
    while ((inFlightJobs.size > 0 || activePollLoops > 0) && Date.now() < deadline) {
        await unrefSleep(Math.min(DRAIN_CHECK_INTERVAL_MS, deadline - Date.now()))
    }
}

/** A grace that is still counting down must not keep the event loop alive, which in the CE suites outlives the hook. */
function unrefSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref()
    })
}

/**
 * Resolves with `whenStopped` as soon as `stop()` is requested, so a parked long-poll does not keep
 * the loop alive for the rest of its 60s RPC timeout. The losing promise is not abandoned silently
 * — an unobserved rejection from the poll we walked away from would surface as an unhandled
 * rejection and, in the API's own test harness, fail an unrelated suite.
 */
async function raceStopRequest<T>({ promise, whenStopped, signal }: RaceStopRequestParams<T>): Promise<T> {
    if (signal.aborted) {
        promise.catch(() => undefined)
        return whenStopped
    }
    let onAbort: (() => void) | null = null
    try {
        return await Promise.race([
            promise,
            new Promise<T>((resolve) => {
                onAbort = (): void => {
                    promise.catch(() => undefined)
                    resolve(whenStopped)
                }
                signal.addEventListener('abort', onAbort, { once: true })
            }),
        ])
    }
    finally {
        if (!isNil(onAbort)) {
            signal.removeEventListener('abort', onAbort)
        }
    }
}

/** A `sleep` that gives up when `stop()` is requested, so a back-off is not a shutdown delay. */
function sleepUnlessStopped({ ms, signal }: { ms: number, signal: AbortSignal }): Promise<void> {
    return raceStopRequest({ promise: sleep(ms), whenStopped: undefined, signal })
}

function scheduleReconnect(): void {
    if (closing || reconnectTimer !== null || socket?.connected === true) {
        return
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (closing || socket?.connected === true) {
            return
        }
        logger.info('Reconnecting to the API server after a server-side disconnect')
        socket?.connect()
    }, MANUAL_RECONNECT_DELAY_MS)
}

/**
 * The loops, started once per `start()`; a reconnect does not restart them. Shutting the managers
 * down on every connect to start fresh ones killed every engine that was mid-job, and each of those
 * runs failed as an internal error and waited out the retry backoff (#585). If the loops ever all
 * exit anyway, the next connect starts them again rather than leaving a worker that is connected
 * and polls nothing.
 */
function launchPollingWorkers(apiClient: WorkerToApiContract): Promise<void> {
    const loops = startPollingWorkers(apiClient)
    void loops
        .catch((err) => {
            logger.error({ error: err }, 'Polling workers crashed unexpectedly')
        })
        .finally(() => {
            if (pollingWorkers === loops) {
                pollingWorkers = null
            }
        })
    return loops
}

async function startPollingWorkers(apiClient: WorkerToApiContract): Promise<void> {
    // A `connect` that lands after `stop()` would otherwise start loops against an aborted
    // controller, where every poll returns instantly and the loop spins on the CPU.
    if (stopped) return

    if (sandboxManagers.length === 0) {
        sandboxManagers = createSandboxManagers()
        const { data: settings } = tryCatchSync(() => workerSettings.getSettings())
        sandboxSettings = settings
    }

    // Captured per start: a loop still finishing a job that a previous `stop()` abandoned must see
    // that stop, not the `stopped = false` of the `start()` after it.
    const { signal } = stopController

    // One `abort` listener per loop lives on the shared signal at a time. Node warns past 10, so
    // size the budget to the loops actually running rather than disabling the leak check outright.
    setMaxListeners(sandboxManagers.length + DEFAULT_MAX_LISTENERS, signal)

    logger.info({ concurrency: sandboxManagers.length }, 'Starting polling workers')

    // Settled rather than all: one loop failing must not end the promise while its siblings still
    // run, or the next connect would start a second set of loops beside them.
    await Promise.allSettled(sandboxManagers.map((sbManager, workerIndex) =>
        pollAndExecute({ apiClient, sbManager, workerIndex, signal }),
    ))
}

function createSandboxManagers(): SandboxManager[] {
    const rawConcurrency = Number(system.get(WorkerSystemProp.WORKER_CONCURRENCY) ?? '1')
    const concurrency = Number.isInteger(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 1
    if (!Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
        logger.warn({ rawConcurrency }, 'Invalid AP_WORKER_CONCURRENCY value, falling back to 1')
    }
    const proxyPort = egressStack?.proxyPort ?? null
    return Array.from({ length: concurrency }, (_, i) => createSandboxManager({ boxId: i + 1, proxyPort }))
}

/**
 * Sandboxes are kept across a reconnect so that they stay warm, but each one bakes in the settings
 * it was created with, the SSRF allow list among them. Compared against the settings the sandboxes
 * were built with, not the previous connection's: a connect that stored new settings and dropped
 * before reaching this point must not make the next one look unchanged. An idle sandbox is replaced
 * at once; a busy one finishes its job first, since killing it would fail that run.
 */
function recycleSandboxesIfSettingsChanged(): void {
    const { data: currentSettings } = tryCatchSync(() => workerSettings.getSettings())
    if (isNil(currentSettings) || JSON.stringify(currentSettings) === JSON.stringify(sandboxSettings)) {
        return
    }
    sandboxSettings = currentSettings
    const busyManagers = new Set([...inFlightJobs.values()].map(({ sbManager }) => sbManager))
    const idleManagers = sandboxManagers.filter((sm) => !busyManagers.has(sm))
    logger.info({ idle: idleManagers.length, busy: busyManagers.size }, 'Worker settings changed: idle sandboxes are replaced now, busy ones after their job')
    sandboxManagers.forEach((sm) => sm.markStale())
    idleManagers.forEach((sm) => {
        void tryCatch(() => sm.invalidate(logger))
    })
}

/**
 * Renews every in-flight lease as soon as the connection is back, rather than at its next tick, so a
 * job whose lock the API has already given away learns it now. A lease the outage outlived needs no
 * asking: its deadline in `leases` has already given it up.
 */
function reconfirmLeases({ apiClient }: { apiClient: WorkerToApiContract }): void {
    for (const token of inFlightJobs.keys()) {
        void renewLease({ apiClient, token })
    }
}

/** One tick of a job's lease. Not sent while disconnected: the reconnect renews every lease itself. */
function tickLease({ apiClient, token }: { apiClient: WorkerToApiContract, token: string }): void {
    if (socket?.connected === true) {
        void renewLease({ apiClient, token })
    }
}

async function renewLease({ apiClient, token }: { apiClient: WorkerToApiContract, token: string }): Promise<void> {
    const inFlight = inFlightJobs.get(token)
    if (isNil(inFlight) || !isNil(inFlight.givenUp)) {
        return
    }
    const { jobId, queueName } = inFlight.job
    const sentAt = leases.now()
    const { data, error } = await tryCatch(() => apiClient.extendLock({ jobId, token, queueName }))
    if (error) {
        inFlight.log.warn({ error, jobId }, 'Failed to extend lock')
        return
    }
    if (data?.leaseLost === true) {
        await abandonLostLease({ token, reason: 'refused by the API', leaseAgeMs: leases.ageMs({ token }) })
        return
    }
    // An API from before #585 answers nothing: that confirms nothing, and the deadline stands.
    if (isNil(data)) {
        return
    }
    leases.confirm({ token, sentAt })
}

/**
 * The job is no longer this worker's: its lock expired or went to a redelivered copy. From here on
 * nothing it does reaches the API (`givenUpGuard`, `engineRunScope`), its sandbox is stopped, and it
 * reports no completion that could overwrite the copy's.
 */
async function abandonLostLease({ token, reason, leaseAgeMs }: AbandonLostLeaseParams): Promise<void> {
    const inFlight = inFlightJobs.get(token)
    if (isNil(inFlight) || !isNil(inFlight.givenUp)) {
        return
    }
    inFlightJobs.set(token, { ...inFlight, givenUp: 'lease-lost' })
    leases.forget({ token })
    inFlight.log.warn({ jobId: inFlight.job.jobId, reason, leaseAgeMs }, 'Lease lost: stopping the job, the API may already have handed it to another worker')
    const { error } = await tryCatch(() => inFlight.sbManager.invalidate(inFlight.log))
    if (error) {
        inFlight.log.error({ error, jobId: inFlight.job.jobId }, 'Failed to stop the sandbox of a job whose lease was lost')
    }
}

/** Restarts its loop if it throws: a slot whose loop died would otherwise sit idle until the process restarts. */
async function pollAndExecute({ apiClient, sbManager, workerIndex, signal }: PollAndExecuteParams): Promise<void> {
    const workerLog = logger.child({ workerIndex })
    workerLog.info('Polling worker started')
    activePollLoops++

    try {
        await prewarmSlot({ apiClient, sbManager, workerLog, signal })
        while (!signal.aborted) {
            const { error } = await tryCatch(() => runPollLoop({ apiClient, sbManager, workerLog, signal }))
            if (isNil(error)) {
                return
            }
            workerLog.error({ error }, 'Polling worker crashed, restarting it')
            await sleepUnlessStopped({ ms: POLL_LOOP_RESTART_DELAY_MS, signal })
        }
    }
    finally {
        activePollLoops--
    }
}

/**
 * Starts this slot's sandbox before its first poll, so a job can never race the prewarm for the
 * slot (#419). Once per loop and outside its crash restart: a reconnect starts no new loop, so this
 * is the only prewarm the slot's manager ever sees while it is in use. Skipped for a loop that is not
 * going to poll (stopped, disconnected again, or about to pause on a version mismatch), and abandoned
 * on `stop()` like a poll is. An abandoned prewarm cannot leak an engine: `stop()` shuts the
 * manager down, and the manager then starts no sandbox after the install and shuts down one that
 * was already starting. Its provisioning RPCs go through the gated client, so a prewarm caught by a
 * disconnect waits for the reconnect and fails after the RPC budget, and the slot polls anyway.
 */
async function prewarmSlot({ apiClient, sbManager, workerLog, signal }: RunPollLoopParams): Promise<void> {
    if (signal.aborted || !connectionGate.isOpen() || workerSettings.getSettings().APP_VERSION !== AP_VERSION) {
        return
    }
    await raceStopRequest({ promise: sbManager.prewarm({ log: workerLog, apiClient }), whenStopped: undefined, signal })
}

async function runPollLoop({ apiClient, sbManager, workerLog, signal }: RunPollLoopParams): Promise<void> {
    while (!signal.aborted) {
        if (!connectionGate.isOpen()) {
            await connectionGate.whenOpen({ signal })
            continue
        }
        const generation = connectionGeneration

        const { data: machineInfo, error: machineError } = await tryCatch(buildMachineInfo)
        if (machineError) {
            workerLog.error({ error: machineError }, 'Failed to build machine info')
            await sleepUnlessStopped({ ms: 20000, signal })
            continue
        }

        const appVersion = workerSettings.getSettings().APP_VERSION
        if (appVersion !== AP_VERSION) {
            workerLog.warn({ appVersion, workerVersion: AP_VERSION }, 'Connected app version mismatch — pausing polling until reconnect to a compatible app')
            // `poll` is what refreshes this worker's registry entry, and the gate we are in means
            // it is never called — so without a heartbeat the API expires the entry of a worker
            // that is still connected, and loses its version with it (#222).
            socket?.emit(WebsocketServerEvent.WORKER_HEALTHCHECK, machineInfo)
            await sleepUnlessStopped({ ms: VERSION_MISMATCH_POLL_PAUSE_MS, signal })
            continue
        }

        const { data: job, error: pollError } = await tryCatch(() => raceStopRequest({
            promise: apiClient.poll(machineInfo),
            // `null` and not a dedicated sentinel: the loop already treats an empty poll as
            // "nothing to do, go round again", and going round again re-reads the signal, which
            // `stop()` has just aborted. One exit path, not two.
            whenStopped: null,
            signal,
        }))
        if (pollError && connectionGeneration !== generation) {
            // socket.io fails a pending poll the moment the connection drops. That is not the API
            // failing, so no back-off: the head of the loop waits for the reconnect instead.
            workerLog.debug('Poll interrupted by a disconnect, waiting for the reconnect')
            continue
        }
        if (pollError) {
            workerLog.error({ error: pollError }, 'Poll failed')
            await sleepUnlessStopped({ ms: 25000, signal })
            continue
        }

        if (!job) {
            workerLog.debug('Poll returned null, re-polling')
            continue
        }

        // Registered before anything else can throw, so the job is always drained and unregistered.
        inFlightJobs.set(job.token, { job, sbManager, log: workerLog, givenUp: null })
        leases.track({ token: job.token })
        try {
            workerLog.debug({ jobId: job.jobId, jobType: job.jobData.jobType }, 'Job received from poll')
            await runJob({ apiClient, sbManager, job, workerLog })
        }
        finally {
            inFlightJobs.delete(job.token)
            leases.forget({ token: job.token })
        }
    }
}

async function runJob({ apiClient, sbManager, job, workerLog }: RunJobParams): Promise<void> {
    const leaseRenewal = setInterval(() => tickLease({ apiClient, token: job.token }), leaseTracker.renewalIntervalMs)

    const timings = jobTimings.create()
    const jobStartedAt = performance.now()
    const { data: result, error: execError } = await tryCatch(() =>
        executeJob({ apiClient, job, sbManager, timings }),
    )
    const status = execError ? EngineResponseStatus.INTERNAL_ERROR : result.status

    const completeStartedAt = performance.now()
    const givenUp = inFlightJobs.get(job.token)?.givenUp ?? null
    const { error: completeError } = !isNil(givenUp) ? { error: null } : await tryCatch(() =>
        apiClient.completeJob({
            jobId: job.jobId,
            token: job.token,
            queueName: job.queueName,
            status,
            errorMessage: buildErrorMessage(execError ?? undefined, result ?? undefined),
            logs: extractLogs(execError ?? undefined, result ?? undefined),
            retryable: readRetryable({ execError: execError ?? undefined, result: result ?? undefined }),
            response: result?.kind === JobResultKind.SYNCHRONOUS ? result.response : undefined,
        }),
    )
    const jobFinishedAt = performance.now()

    clearInterval(leaseRenewal)

    if (completeError) {
        workerLog.error({ error: completeError, jobId: job.jobId }, 'Failed to complete job')
    }

    // One line per job, whatever its outcome, so a slow run can be split into queue, provision,
    // cold start and engine time from the logs alone (#587). Queue age is on the API's
    // `Dequeued job` line for the same jobId, measured on the clock that wrote the timestamp.
    workerLog.info({
        jobId: job.jobId,
        ...readJobRef(job.jobData),
        attemptsStarted: job.attempsStarted,
        status,
        completed: isNil(givenUp) && isNil(completeError),
        givenUp,
        durationMs: Math.round(jobFinishedAt - jobStartedAt),
        completeMs: Math.round(jobFinishedAt - completeStartedAt),
        ...timings.summary(),
    }, '[worker] Job finished')
}

async function executeJob({ apiClient, job, sbManager, timings }: ExecuteJobParams): Promise<JobResult> {
    const rawData = job.jobData
    const jobData = JobData.parse(rawData)
    return tracer.startActiveSpan('worker.executeJob', {
        attributes: {
            'worker.jobId': job.jobId,
            'worker.jobType': jobData.jobType,
        },
    }, async (span) => {
        const log = logger.child({ jobId: job.jobId, jobType: jobData.jobType })
        const apiUrl = getApiUrl()
        const { PUBLIC_URL: publicUrl } = await workerSettings.waitForSettings()
        log.debug({ apiUrl, publicUrl }, 'Worker settings resolved')
        const isGivenUp = (): boolean => !isNil(inFlightJobs.get(job.token)?.givenUp)
        const ctx: JobContext = {
            apiClient: givenUpGuard.apiClient({ apiClient, isGivenUp }),
            sandboxManager: givenUpGuard.sandboxManager({
                sandboxManager: jobTimings.instrumentSandboxManager({ sandboxManager: sbManager, timings }),
                isGivenUp,
            }),
            jobId: job.jobId,
            attemptsStarted: job.attempsStarted,
            canRetryBeforeExecution: job.canRetryBeforeExecution ?? false,
            engineToken: job.engineToken,
            internalApiUrl: apiUrl,
            publicApiUrl: ensurePublicApiUrl(publicUrl),
            log,
            timings,
        }
        try {
            const handler = getHandler(jobData.jobType)
            log.debug({ handlerType: handler.jobType }, 'Executing job with handler')
            const { data: result, error } = await tryCatch(() => handler.execute(ctx, jobData))
            if (error) {
                log.error({ err: error }, 'Job execution failed')
                span.recordException(error)
                throw error
            }
            log.debug('Job completed')
            return result
        }
        finally {
            span.end()
        }
    })
}

export function ensurePublicApiUrl(publicUrl: string): string {
    if (publicUrl.endsWith('/api/')) return publicUrl
    if (publicUrl.endsWith('/api')) return publicUrl + '/'
    if (publicUrl.endsWith('/')) return publicUrl + 'api/'
    return publicUrl + '/api/'
}

/**
 * The ids that join the `Job finished` line to a `flow_run` row. Read from the raw payload, not
 * the parsed one: the line is written for jobs that failed to parse too, and must not throw on one.
 */
function readJobRef(jobData: unknown): JobRef {
    if (typeof jobData !== 'object' || jobData === null) {
        return {}
    }
    const jobType = readStringField({ value: jobData, key: 'jobType' })
    return {
        jobType,
        flowId: readStringField({ value: jobData, key: 'flowId' }),
        runId: jobType === WorkerJobType.EXECUTE_FLOW ? readStringField({ value: jobData, key: 'runId' }) : undefined,
    }
}

function readStringField({ value, key }: { value: object, key: string }): string | undefined {
    const field: unknown = Reflect.get(value, key)
    return typeof field === 'string' ? field : undefined
}

async function fetchAndStoreSettings(sock: Socket): Promise<void> {
    const { data: request, error } = await tryCatch(buildMachineInfo)
    if (error) {
        logger.error({ error }, 'Failed to build machine info for settings fetch')
        return
    }
    return new Promise<void>((resolve) => {
        sock.emit(WebsocketServerEvent.FETCH_WORKER_SETTINGS, request, (response: WorkerSettingsResponse) => {
            const localExecutionMode = system.get(WorkerSystemProp.EXECUTION_MODE)
            if (!isNil(localExecutionMode)) {
                response.EXECUTION_MODE = localExecutionMode
            }
            const workerGroupId = system.get(WorkerSystemProp.WORKER_GROUP_ID)
            if (!isNil(workerGroupId)) {
                const processSandboxedModes = [ExecutionMode.SANDBOX_PROCESS, ExecutionMode.SANDBOX_CODE_AND_PROCESS]
                if (!processSandboxedModes.includes(response.EXECUTION_MODE as ExecutionMode)) {
                    throw new Error(`Worker group "${workerGroupId}" requires AP_EXECUTION_MODE to be one of: ${processSandboxedModes.join(', ')}. Got: ${response.EXECUTION_MODE}`)
                }
                const reuseSandbox = system.get(WorkerSystemProp.REUSE_SANDBOX)
                if (isNil(reuseSandbox)) {
                    throw new Error(`Worker group "${workerGroupId}" requires AP_REUSE_SANDBOX to be set (true or false)`)
                }
            }
            workerSettings.set(response)
            logger.info({ environment: response.ENVIRONMENT, executionMode: response.EXECUTION_MODE }, 'Worker settings loaded')
            resolve()
        })
    })
}

function getWorkerProps(): WorkerProps {
    // The version comes from this process's own package, not from the settings the API sends,
    // so it is knowable before the first settings fetch resolves — and it must be reported then,
    // because a version-skewed worker never completes a poll and its registration would
    // otherwise carry no version at all, which is the one field that case is about (#222).
    const { data: settings } = tryCatchSync(() => workerSettings.getSettings())
    if (isNil(settings)) {
        return { version: AP_VERSION }
    }
    return {
        EXECUTION_MODE: settings.EXECUTION_MODE,
        WORKER_CONCURRENCY: system.get(WorkerSystemProp.WORKER_CONCURRENCY)!,
        SANDBOX_MEMORY_LIMIT: settings.SANDBOX_MEMORY_LIMIT,
        REUSE_SANDBOX: system.get(WorkerSystemProp.REUSE_SANDBOX) ?? 'false',
        version: AP_VERSION,
    }
}

async function buildMachineInfo(): Promise<WorkerMachineHealthcheckRequest> {
    const memInfo = await systemUsage.getContainerMemoryUsage()
    const diskInfo = await systemUsage.getDiskInfo()
    const cpuCores = await systemUsage.getCpuCores()
    return {
        workerId,
        cpuUsagePercentage: systemUsage.getCpuUsage(),
        diskInfo,
        workerProps: getWorkerProps(),
        ramUsagePercentage: memInfo.ramUsage,
        totalAvailableRamInBytes: memInfo.totalRamInBytes,
        totalCpuCores: cpuCores,
        ip: workerHostname,
        sandboxes: await buildSandboxInfo(),
    }
}

async function buildSandboxInfo(): Promise<SandboxInformation[]> {
    const activeSandboxes = sandboxManagers
        .map((sandboxManager) => sandboxManager.getActiveSandbox())
        .filter((sandbox): sandbox is ActiveSandboxInfo => !isNil(sandbox))

    return Promise.all(activeSandboxes.map(async (sandbox) => ({
        sandboxId: sandbox.sandboxId,
        boxId: sandbox.boxId,
        busy: sandbox.busy,
        memoryUsageBytes: await systemUsage.getProcessTreeMemoryBytes(sandbox.pid),
    })))
}

async function warmupPiecesOnStartup(apiClient: WorkerToApiContract): Promise<void> {
    const { data: pieces, error } = await tryCatch(() => apiClient.getUsedQadams({}))
    if (error) {
        logger.error({ error }, 'Failed to fetch used pieces for warmup')
        return
    }
    if (!pieces || pieces.length === 0) {
        logger.info('No pieces to warm up')
        return
    }
    logger.info({ count: pieces.length }, 'Starting piece cache warmup')
    const { error: installError } = await tryCatch(() =>
        // Filtered, like the provisioner's install: without `--filter`, bun installs every
        // workspace in the shared cache, and it does so while holding the cross-replica
        // fileLock that job provisioning also waits on. That was inert while the workspaces
        // glob matched nothing; it is not any more.
        qadamInstaller(logger, apiClient).install({ pieces, includeFilters: true }),
    )
    if (installError) {
        logger.error({ error: installError }, 'Failed to install pieces during startup warmup')
    }
    else {
        void tryCatch(() => apiClient.markQadamAsUsed({ pieces }))
    }
    logger.info({ count: pieces.length }, 'Piece cache warmup complete')
}

function buildErrorMessage(execError: Error | undefined, result: JobResult | undefined): string | undefined {
    if (execError) {
        return execError.message
    }
    const isFailure = result?.kind === JobResultKind.SYNCHRONOUS && result.status !== EngineResponseStatus.OK
    if (!isFailure) {
        return undefined
    }
    return result.errorMessage
}

function extractLogs(execError: Error | undefined, result: JobResult | undefined): string | undefined {
    const thrown = execError instanceof ClassifiedJobFailure ? execError.original : execError
    if (thrown instanceof QadamFlowError) {
        const { params } = thrown.error
        const parts: string[] = []
        if (!isNil(params) && 'standardOutput' in params && params.standardOutput) parts.push(`stdout:\n${params.standardOutput}`)
        if (!isNil(params) && 'standardError' in params && params.standardError) parts.push(`stderr:\n${params.standardError}`)
        return parts.length > 0 ? parts.join('\n') : undefined
    }
    if (result && 'logs' in result) {
        return result.logs
    }
    return undefined
}

// Absent unless the handler classified the failure; the broker then applies the job's own backoff (#584).
function readRetryable({ execError, result }: ReadRetryableParams): boolean | undefined {
    if (execError instanceof ClassifiedJobFailure) {
        return execError.retryable
    }
    if (!isNil(execError) || result?.kind !== JobResultKind.FIRE_AND_FORGET) {
        return undefined
    }
    return result.retryable
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function createConnectionGate(): ConnectionGate {
    let open = false
    let waiters: (() => void)[] = []
    return {
        open(): void {
            open = true
            const released = waiters
            waiters = []
            released.forEach((release) => release())
        },
        close(): void {
            open = false
        },
        isOpen: (): boolean => open,
        // Also settles once `signal` aborts, and then takes its waiter out: a caller that stopped
        // waiting must not leave one behind for every call made during a long outage.
        whenOpen({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
            if (open || signal?.aborted === true) {
                return Promise.resolve()
            }
            return new Promise<void>((resolve) => {
                const release = (): void => {
                    waiters = waiters.filter((waiter) => waiter !== release)
                    signal?.removeEventListener('abort', release)
                    resolve()
                }
                waiters = [...waiters, release]
                signal?.addEventListener('abort', release, { once: true })
            })
        },
    }
}


function startHealthServer(): ReturnType<typeof createServer> {
    const port = Number(process.env[WorkerSystemProp.PORT] ?? system.get(WorkerSystemProp.PORT))
    const healthPaths = new Set(['/worker/health', '/v1/health', '/api/v1/health'])
    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url && healthPaths.has(req.url)) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok' }))
        }
        else {
            res.writeHead(404)
            res.end()
        }
    })
    server.listen(port, () => {
        logger.info({ port }, 'Health server listening')
    })
    return server
}

type WorkerStartParams = {
    apiUrl: string
    socketUrl: { url: string, path: string }
    workerToken: string
    withHealthServer?: boolean
}

type RaceStopRequestParams<T> = {
    promise: Promise<T>
    whenStopped: T
    signal: AbortSignal
}

type JobRef = {
    jobType?: string
    flowId?: string
    runId?: string
}

type ExecuteJobParams = {
    apiClient: WorkerToApiContract
    job: ConsumeJobRequest
    sbManager: SandboxManager
    timings: JobTimings
}

type PollAndExecuteParams = {
    apiClient: WorkerToApiContract
    sbManager: SandboxManager
    workerIndex: number
    signal: AbortSignal
}

type RunPollLoopParams = {
    apiClient: WorkerToApiContract
    sbManager: SandboxManager
    workerLog: Logger
    signal: AbortSignal
}

type RunJobParams = {
    apiClient: WorkerToApiContract
    sbManager: SandboxManager
    job: ConsumeJobRequest
    workerLog: Logger
}

type ReadRetryableParams = {
    execError: Error | undefined
    result: JobResult | undefined
}

type InFlightJob = {
    job: ConsumeJobRequest
    sbManager: SandboxManager
    log: Logger
    /** Set once the job may no longer report completion: its lease went elsewhere, or a stop abandoned it. */
    givenUp: GivenUpReason | null
}

type GivenUpReason = 'lease-lost' | 'shutdown'

type AbandonLostLeaseParams = {
    token: string
    reason: string
    leaseAgeMs: number | null
}

type ConnectionGate = {
    open(): void
    close(): void
    isOpen(): boolean
    whenOpen(params?: { signal?: AbortSignal }): Promise<void>
}

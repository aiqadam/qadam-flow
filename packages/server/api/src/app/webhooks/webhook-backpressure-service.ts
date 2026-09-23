import { FastifyBaseLogger } from 'fastify'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { jobQueue } from '../workers/job-queue/job-queue'
import { workerMachineCache } from '../workers/machine/machine-cache'

const DEFAULT_SLOTS_PER_WORKER = 1

/**
 * A sync webhook's caller waits at most `AP_WEBHOOK_TIMEOUT_SECONDS` (webhook.service.ts). Once
 * every worker slot is busy AND there is already a full extra round of runs waiting behind them
 * (`waiting >= slots`), a freshly-accepted run would have to wait through at least two full
 * dispatch rounds before it even reaches a sandbox — on top of whatever its own execution then
 * takes. That is the earliest point at which "will not start in time" can be said without
 * guessing a per-run duration, so it is the trip point here rather than a fixed constant.
 *
 * Deliberately conservative: the measured baseline (#510) — 40 concurrent callers against 25
 * slots — settles at a `waiting` depth of ~15, well under the 25-slot trip point, so today's
 * default-config load is untouched by this check. It only fires on a genuine backlog, not on
 * ordinary queueing.
 *
 * The slot count comes from the worker registry (`workerMachineCache`), which every connected
 * worker keeps fresh via its own healthcheck (`AP_WORKER_CONCURRENCY`), rather than a hardcoded
 * number — so it stays correct as replicas or concurrency change.
 *
 * A registry read of zero slots is treated as "unknown", not "no capacity": the registry entry
 * only exists between healthchecks and expires after `WORKER_MACHINE_TTL_SECONDS` of silence, so a
 * momentary gap (or, in a test harness, no worker process ever having connected) must not read as
 * a hard outage and start refusing every webhook.
 */
export const webhookBackpressureService = (log: FastifyBaseLogger) => ({
    async checkCapacity(): Promise<BackpressureResult> {
        const enabled = system.getBoolean(AppSystemProp.SYNC_WEBHOOK_BACKPRESSURE_ENABLED) ?? true
        if (!enabled) {
            return { ok: true }
        }

        const slots = await getTotalWorkerSlots()
        if (slots === 0) {
            return { ok: true }
        }

        const retryAfterSeconds = system.getNumberOrThrow(AppSystemProp.SYNC_WEBHOOK_BACKPRESSURE_RETRY_AFTER_SECONDS)
        const queue = jobQueue(log).getSharedQueue()
        const jobCounts = await queue.getJobCounts('waiting', 'active', 'prioritized')
        const waiting = jobCounts.waiting + jobCounts.prioritized
        const active = jobCounts.active

        if (active >= slots && waiting >= slots) {
            log.warn({ slots, waiting, active }, '[webhookBackpressureService#checkCapacity] Every slot is busy and a full extra round is already queued, refusing sync webhook upfront')
            return { ok: false, retryAfterSeconds }
        }

        return { ok: true }
    },
})

async function getTotalWorkerSlots(): Promise<number> {
    const onlineWorkers = await workerMachineCache().find()
    return onlineWorkers.reduce((total, worker) => {
        const parsedConcurrency = Number.parseInt(worker.information.workerProps.WORKER_CONCURRENCY ?? '', 10)
        const concurrency = Number.isNaN(parsedConcurrency) ? DEFAULT_SLOTS_PER_WORKER : parsedConcurrency
        return total + concurrency
    }, 0)
}

export type BackpressureResult =
    | { ok: true }
    | { ok: false, retryAfterSeconds: number }

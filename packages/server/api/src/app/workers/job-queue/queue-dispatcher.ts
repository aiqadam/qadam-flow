import { ConsumeJobRequest, isNil, tryCatch } from '@aiqadam/shared'
import { Worker as BullMQWorker } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'

// Exported so machine-cache-expiry.test.ts can pin the relationship with
// WORKER_MACHINE_TTL_SECONDS: an idle worker only re-registers when this long-poll returns, so a
// TTL shorter than this would expire healthy workers. Nothing tied the two together before (#222).
const WAITER_TIMEOUT_MS = 50_000
const ERROR_RETRY_DELAY_MS = 5_000

function createQueueDispatcher(params: {
    queueName: string
    worker: BullMQWorker
    dequeue: (worker: BullMQWorker, queueName: string, log: FastifyBaseLogger) => Promise<ConsumeJobRequest | null>
    onOrphanedJob: (jobId: string, token: string, queueName: string, log: FastifyBaseLogger) => Promise<void>
    log: FastifyBaseLogger
}): QueueDispatcher {
    const { queueName, worker, dequeue, onOrphanedJob, log } = params
    const waiters: Waiter[] = []
    let loopRunning = false

    async function poll({ signal }: PollParams = {}): Promise<ConsumeJobRequest | null> {
        if (signal?.aborted) {
            return null
        }
        return new Promise<ConsumeJobRequest | null>((resolve) => {
            const waiter: Waiter = {
                resolve: (job) => {
                    clearTimeout(waiter.timer)
                    signal?.removeEventListener('abort', dropWaiter)
                    resolve(job)
                },
                timer: setTimeout(() => dropWaiter(), WAITER_TIMEOUT_MS),
            }
            // The socket that asked is gone: a job handed to this waiter would be acked into a
            // closed socket and sit active until its lock expires and the stalled check moves
            // it back, ~139 s later, while every live worker idles (#589).
            function dropWaiter(): void {
                const idx = waiters.indexOf(waiter)
                if (idx !== -1) {
                    waiters.splice(idx, 1)
                }
                waiter.resolve(null)
            }
            signal?.addEventListener('abort', dropWaiter, { once: true })

            waiters.push(waiter)
            startLoop()
        })
    }

    function startLoop(): void {
        if (loopRunning) return
        loopRunning = true
        void runLoop()
    }

    async function runLoop(): Promise<void> {
        while (waiters.length > 0) {
            const { error, data: job } = await tryCatch(() => dequeue(worker, queueName, log))

            if (error) {
                log.error({ queueName, error: String(error) }, '[QueueDispatcher] dequeue error, retrying')
                await sleep(ERROR_RETRY_DELAY_MS)
                continue
            }

            if (isNil(job)) {
                if (waiters.length === 0) break
                continue
            }

            const waiter = waiters.shift()
            if (isNil(waiter)) {
                log.warn({ queueName, jobId: job.jobId }, '[QueueDispatcher] job dequeued but no waiter available, returning to queue')
                const { error: orphanError } = await tryCatch(() => onOrphanedJob(job.jobId, job.token, job.queueName, log))
                if (orphanError) {
                    log.error({ queueName, jobId: job.jobId, error: String(orphanError) }, '[QueueDispatcher] failed to return orphaned job to queue')
                }
                continue
            }

            waiter.resolve(job)
        }
        loopRunning = false
    }

    function close(): void {
        const pending = waiters.splice(0)
        for (const waiter of pending) {
            waiter.resolve(null)
        }
        // Do not reset loopRunning here — the in-flight runLoop will exit
        // naturally when it sees waiters.length === 0 after dequeue returns.
    }

    function waiterCount(): number {
        return waiters.length
    }

    return { poll, close, waiterCount }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

type PollParams = {
    signal?: AbortSignal
}

type Waiter = {
    resolve: (value: ConsumeJobRequest | null) => void
    timer: ReturnType<typeof setTimeout>
}

export type QueueDispatcher = {
    poll(params?: PollParams): Promise<ConsumeJobRequest | null>
    close(): void
    waiterCount(): number
}

export { createQueueDispatcher, WAITER_TIMEOUT_MS, ERROR_RETRY_DELAY_MS }

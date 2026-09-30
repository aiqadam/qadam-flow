import { isNil, WorkerJobType } from '@aiqadam/shared'
import { BackoffOptions, Job, JobsOptions, UnrecoverableError } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'

const EXECUTE_FLOW_ATTEMPTS = 4
const EXECUTE_FLOW_BASE_DELAY_MS = 2_000
const EXECUTE_FLOW_JITTER = 0.5
const PREVIOUS_ERROR_MAX_LENGTH = 300

/**
 * How a failed attempt is retried (#584). Only built-in BullMQ backoffs are persisted on a job, so
 * a job enqueued by this version still retries sanely under an older app that does not know it.
 *
 * An `EXECUTE_FLOW` job retries within seconds, up to three times. Its worker says when that is
 * wrong: a failure after the engine received the operation, or one with a final outcome, arrives
 * with `retryable: false` and becomes an `UnrecoverableError`, because a retry starts again from
 * the trigger and repeats every side effect the first attempt had. Every other failure of it ran
 * nothing: the handler marks what fails before the operation is sent, and what it does not classify
 * (the sandbox slot, parsing the job, a report that fails before execution) precedes it too.
 *
 * Every other job type keeps the queue default: one retry after 8 minutes (`job-queue.ts`).
 */
export const jobRetry = {
    executeFlowJobOptions: {
        attempts: EXECUTE_FLOW_ATTEMPTS,
        // Jitter keeps the retries of runs that failed together, e.g. every slot after a deploy,
        // from landing together.
        backoff: { type: 'exponential', delay: EXECUTE_FLOW_BASE_DELAY_MS, jitter: EXECUTE_FLOW_JITTER },
    } satisfies JobsOptions,

    /**
     * Whether a failure before execution in this delivery will be retried: exactly BullMQ's own
     * `attemptsMade + 1 < attempts` check, which `completeJob` will run on the same job. A job
     * that does not carry the quick backoff, e.g. one enqueued before #584, does not qualify.
     */
    canRetryBeforeExecution(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
        return hasQuickBackoff(job.opts.backoff) && job.attemptsMade + 1 < (job.opts.attempts ?? 1)
    },

    toFailure({ message, retryable }: ToFailureParams): Error {
        return retryable === false ? new UnrecoverableError(message) : new Error(message)
    },

    /** Called after `moveToFailed`, which has counted the attempt and set `finishedOn` or `delay`. */
    logFailedAttempt({ log, job, jobType, retryable }: LogFailedAttemptParams): void {
        const context = {
            jobId: job.id,
            jobType,
            failedAttempt: job.attemptsMade,
            retryable,
            previousError: firstLine(job.failedReason),
        }
        if (retryable === false) {
            log.warn(context, '[jobRetry] Attempt failed after the engine received it, or with a final outcome; not retrying')
            return
        }
        if (isNil(job.finishedOn)) {
            log.warn({ ...context, retryInMs: job.delay }, '[jobRetry] Attempt failed, retrying')
            return
        }
        log.warn(context, '[jobRetry] Attempt failed, no attempts left')
    },
}

function hasQuickBackoff(backoff: number | BackoffOptions | undefined): boolean {
    return typeof backoff === 'object' && backoff.type === 'exponential' && backoff.delay === EXECUTE_FLOW_BASE_DELAY_MS
}

// The failed reason carries the engine's stdout/stderr after the first line, and that is run data.
function firstLine(message: string | undefined): string | undefined {
    if (isNil(message)) {
        return undefined
    }
    return message.split('\n', 1)[0].slice(0, PREVIOUS_ERROR_MAX_LENGTH)
}

type ToFailureParams = {
    message: string
    retryable: boolean | undefined
}

type LogFailedAttemptParams = {
    log: FastifyBaseLogger
    job: Pick<Job, 'id' | 'attemptsMade' | 'finishedOn' | 'delay' | 'failedReason'>
    jobType: WorkerJobType
    retryable: boolean | undefined
}

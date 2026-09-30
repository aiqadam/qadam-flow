import { apDayjsDuration } from '@aiqadam/server-utils'
import { isNil } from '@aiqadam/shared'
import { BackoffOptions, BackoffStrategy, Job, UnrecoverableError } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'

const MAX_ATTEMPTS = 4
const FAILURE_AWARE_BACKOFF = 'qadamFailureAware'
const FAILED_BEFORE_EXECUTION = 'FailedBeforeExecution'
const BEFORE_EXECUTION_BASE_DELAY_MS = 2_000
const UNCLASSIFIED_RETRY_DELAY_MS = apDayjsDuration(8, 'minute').asMilliseconds()
const NO_RETRY = -1
const PREVIOUS_ERROR_MAX_LENGTH = 300

/**
 * How a failed attempt is retried, from the worker's verdict on it (#584). A failure before the
 * engine received the operation ran nothing, is almost always transient (a deploy, a cache race,
 * the API briefly unreachable) and is retried within seconds. A failure after it is never retried:
 * a retry starts again from the trigger and repeats every side effect the first attempt had. A
 * failure the handler does not classify keeps the one retry after 8 minutes that every job had.
 */
export const jobRetry = {
    defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: FAILURE_AWARE_BACKOFF },
    },

    /**
     * Whether a failure before execution in this delivery will be retried: exactly BullMQ's own
     * `attemptsMade + 1 < attempts` check, which `completeJob` will run on the same job. A job
     * enqueued before #584 carries the fixed 8-minute backoff and does not qualify.
     */
    canRetryBeforeExecution(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
        return isFailureAwareBackoff(job.opts.backoff) && job.attemptsMade + 1 < (job.opts.attempts ?? 1)
    },

    toFailure({ message, retryable }: ToFailureParams): Error {
        if (retryable === false) {
            return new UnrecoverableError(message)
        }
        const failure = new Error(message)
        if (retryable === true) {
            failure.name = FAILED_BEFORE_EXECUTION
        }
        return failure
    },

    createBackoffStrategy({ log }: { log: FastifyBaseLogger }): BackoffStrategy {
        // `attemptsMade` is the number of the attempt that just failed, counted from 1.
        return (attemptsMade, _type, err, job) => {
            const previousError = firstLine(err?.message)
            if (err?.name === FAILED_BEFORE_EXECUTION) {
                const retryInMs = withJitter(BEFORE_EXECUTION_BASE_DELAY_MS * 2 ** (attemptsMade - 1))
                log.warn({ jobId: job?.id, failedAttempt: attemptsMade, retryInMs, previousError }, '[jobRetry] Attempt failed before the engine received it, retrying')
                return retryInMs
            }
            if (attemptsMade > 1) {
                return NO_RETRY
            }
            log.warn({ jobId: job?.id, failedAttempt: attemptsMade, retryInMs: UNCLASSIFIED_RETRY_DELAY_MS, previousError }, '[jobRetry] Unclassified failure, retrying once after the legacy delay')
            return UNCLASSIFIED_RETRY_DELAY_MS
        }
    },
}

function isFailureAwareBackoff(backoff: number | BackoffOptions | undefined): boolean {
    return typeof backoff === 'object' && backoff.type === FAILURE_AWARE_BACKOFF
}

// Keeps retries of jobs that failed together, e.g. every slot after a deploy, from landing together.
function withJitter(delayMs: number): number {
    return Math.round(delayMs * (0.5 + Math.random() * 0.5))
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

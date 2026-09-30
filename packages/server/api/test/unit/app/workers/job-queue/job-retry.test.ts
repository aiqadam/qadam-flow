import { WorkerJobType } from '@aiqadam/shared'
import { UnrecoverableError } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jobRetry } from '../../../../../src/app/workers/job-queue/job-retry'

const log: FastifyBaseLogger = pino({ level: 'silent' })

const EIGHT_MINUTES_MS = 8 * 60 * 1000
const LEGACY_OPTIONS = { attempts: 2, backoff: { type: 'exponential', delay: EIGHT_MINUTES_MS } }

describe('jobRetry (#584)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('executeFlowJobOptions', () => {
        it('persists only a built-in BullMQ backoff, so an older app still retries the job', () => {
            expect(jobRetry.executeFlowJobOptions).toEqual({ attempts: 4, backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 } })
        })
    })

    describe('canRetryBeforeExecution', () => {
        it('is true while attempts remain on a job with the quick backoff', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: jobRetry.executeFlowJobOptions })).toBe(true)
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 2, opts: jobRetry.executeFlowJobOptions })).toBe(true)
        })

        it('is false on the last attempt, exactly where BullMQ stops retrying', () => {
            const attempts = jobRetry.executeFlowJobOptions.attempts
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: attempts - 1, opts: jobRetry.executeFlowJobOptions })).toBe(false)
        })

        it('is false on a job with the queue default, e.g. one enqueued before #584', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: LEGACY_OPTIONS })).toBe(false)
        })

        it('is false on a user-interaction job, which is never retried', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: { ...jobRetry.executeFlowJobOptions, attempts: 1 } })).toBe(false)
        })
    })

    describe('toFailure', () => {
        it('makes a failure after execution unrecoverable, so BullMQ never retries it', () => {
            const failure = jobRetry.toFailure({ message: 'engine gone', retryable: false })

            expect(failure).toBeInstanceOf(UnrecoverableError)
            expect(failure.message).toBe('engine gone')
        })

        it('leaves any other failure to the job\'s own backoff', () => {
            expect(jobRetry.toFailure({ message: 'ENOENT', retryable: true })).not.toBeInstanceOf(UnrecoverableError)
            expect(jobRetry.toFailure({ message: 'boom', retryable: undefined })).not.toBeInstanceOf(UnrecoverableError)
        })
    })

    describe('logFailedAttempt', () => {
        const failedJob = {
            id: 'job-1',
            attemptsMade: 1,
            failedReason: 'Sandbox did not connect\nstdout:\nrun output',
        }

        it('logs the retry with its delay, and only the first line of the failed reason', () => {
            const warn = vi.spyOn(log, 'warn')

            jobRetry.logFailedAttempt({ log, job: { ...failedJob, delay: 1_500, finishedOn: undefined }, jobType: WorkerJobType.EXECUTE_FLOW, retryable: true })

            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ retryInMs: 1_500, failedAttempt: 1, previousError: 'Sandbox did not connect' }), '[jobRetry] Attempt failed, retrying')
        })

        it('says a failure after execution is not retried, even with attempts left', () => {
            const warn = vi.spyOn(log, 'warn')

            jobRetry.logFailedAttempt({ log, job: { ...failedJob, delay: 0, finishedOn: Date.now() }, jobType: WorkerJobType.EXECUTE_FLOW, retryable: false })

            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ retryable: false }), expect.stringContaining('not retrying'))
        })

        it('says when the attempts ran out', () => {
            const warn = vi.spyOn(log, 'warn')

            jobRetry.logFailedAttempt({ log, job: { ...failedJob, delay: 0, finishedOn: Date.now() }, jobType: WorkerJobType.EXECUTE_FLOW, retryable: true })

            expect(warn).toHaveBeenCalledWith(expect.anything(), '[jobRetry] Attempt failed, no attempts left')
        })
    })
})

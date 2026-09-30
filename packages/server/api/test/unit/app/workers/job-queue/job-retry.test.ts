import { UnrecoverableError } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jobRetry } from '../../../../../src/app/workers/job-queue/job-retry'

const mockLog = {
    warn: vi.fn(),
} as unknown as FastifyBaseLogger

const EIGHT_MINUTES_MS = 8 * 60 * 1000

describe('jobRetry (#584)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('canRetryBeforeExecution', () => {
        it('is true while attempts remain on a job with the failure-aware backoff', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: jobRetry.defaultJobOptions })).toBe(true)
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 2, opts: jobRetry.defaultJobOptions })).toBe(true)
        })

        it('is false on the last attempt, exactly where BullMQ stops retrying', () => {
            const attempts = jobRetry.defaultJobOptions.attempts
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: attempts - 1, opts: jobRetry.defaultJobOptions })).toBe(false)
        })

        it('is false on a job enqueued before #584, whose backoff is the fixed 8 minutes', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: { attempts: 2, backoff: { type: 'exponential', delay: EIGHT_MINUTES_MS } } })).toBe(false)
        })

        it('is false on a user-interaction job, which is never retried', () => {
            expect(jobRetry.canRetryBeforeExecution({ attemptsMade: 0, opts: { ...jobRetry.defaultJobOptions, attempts: 1 } })).toBe(false)
        })
    })

    describe('toFailure', () => {
        it('makes a failure after execution unrecoverable, so BullMQ never retries it', () => {
            const failure = jobRetry.toFailure({ message: 'engine gone', retryable: false })

            expect(failure).toBeInstanceOf(UnrecoverableError)
            expect(failure.message).toBe('engine gone')
        })

        it('marks a failure before execution for the quick backoff', () => {
            const failure = jobRetry.toFailure({ message: 'ENOENT', retryable: true })

            expect(failure).not.toBeInstanceOf(UnrecoverableError)
            expect(failure.name).toBe('FailedBeforeExecution')
        })

        it('leaves an unclassified failure a plain error', () => {
            const failure = jobRetry.toFailure({ message: 'boom', retryable: undefined })

            expect(failure).not.toBeInstanceOf(UnrecoverableError)
            expect(failure.name).toBe('Error')
        })
    })

    describe('backoff strategy', () => {
        const strategy = jobRetry.createBackoffStrategy({ log: mockLog })
        const beforeExecution = jobRetry.toFailure({ message: 'Sandbox did not connect\nstdout:\nsecret-ish run output', retryable: true })

        it('retries a failure before execution within seconds, doubling per attempt', async () => {
            vi.spyOn(Math, 'random').mockReturnValue(1)

            expect(await Promise.all([1, 2, 3].map((attempt) => strategy(attempt, 'qadamFailureAware', beforeExecution)))).toEqual([2_000, 4_000, 8_000])
        })

        it('jitters the delay down to half, so a batch that failed together does not retry together', async () => {
            vi.spyOn(Math, 'random').mockReturnValue(0)

            expect(await strategy(1, 'qadamFailureAware', beforeExecution)).toBe(1_000)
        })

        it('logs only the first line of the failed reason, never the run output after it', async () => {
            await strategy(1, 'qadamFailureAware', beforeExecution)

            expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ previousError: 'Sandbox did not connect' }), expect.any(String))
        })

        it('keeps the one legacy retry after 8 minutes for an unclassified failure, and no second one', async () => {
            const unclassified = jobRetry.toFailure({ message: 'boom', retryable: undefined })

            expect(await strategy(1, 'qadamFailureAware', unclassified)).toBe(EIGHT_MINUTES_MS)
            expect(await strategy(2, 'qadamFailureAware', unclassified)).toBe(-1)
        })
    })
})

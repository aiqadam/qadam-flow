import { EngineResponseStatus, TriggerHookType, WorkerJobType } from '@aiqadam/shared'
import { Job } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lockValues, fromId, publish, onJobFinished } = vi.hoisted(() => ({
    lockValues: new Map<string, string>(),
    fromId: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    onJobFinished: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('bullmq', async (importOriginal) => {
    const actual = await importOriginal<typeof import('bullmq')>()
    class FakeWorker {
        waitUntilReady = vi.fn().mockResolvedValue(undefined)
        startStalledCheckTimer = vi.fn().mockResolvedValue(undefined)
        on = vi.fn()
        close = vi.fn().mockResolvedValue(undefined)
        client = Promise.resolve({ get: (key: string) => Promise.resolve(lockValues.get(key) ?? null) })
        toKey(jobId: string): string {
            return `bull:workerJobs:${jobId}`
        }
    }
    return { ...actual, Worker: FakeWorker, Job: { ...actual.Job, fromId } }
})

vi.mock('../../../../../src/app/database/redis-connections', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/app/database/redis-connections')>()
    return { ...actual, redisConnections: { ...actual.redisConnections, create: vi.fn().mockResolvedValue({}) } }
})

vi.mock('../../../../../src/app/workers/engine-response-watcher', () => ({
    engineResponseWatcher: () => ({ publish }),
}))

vi.mock('../../../../../src/app/workers/job-queue/interceptors/rate-limiter-interceptor', () => ({
    rateLimiterInterceptor: { preDispatch: vi.fn(), onJobFinished },
}))

vi.mock('../../../../../src/app/workers/job-queue/interceptors/zombie-polling-interceptor', () => ({
    zombiePollingInterceptor: { preDispatch: vi.fn(), onJobFinished: vi.fn().mockResolvedValue(undefined) },
}))

import { jobBroker } from '../../../../../src/app/workers/job-queue/job-broker'

const log: FastifyBaseLogger = pino({ level: 'silent' })

const JOB_ID = 'job-1'
const TOKEN = 'token-original'
const LOCK_KEY = `bull:workerJobs:${JOB_ID}:lock`

function createJob(): Job {
    return {
        id: JOB_ID,
        data: {
            jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
            platformId: 'plat-1',
            projectId: 'proj-1',
            schemaVersion: 1,
            flowId: 'flow-1',
            flowVersionId: 'flow-version-1',
            test: false,
            hookType: TriggerHookType.ON_ENABLE,
            requestId: 'req-1',
            webserverId: 'webserver-1',
        },
        moveToCompleted: vi.fn().mockImplementation(() => {
            lockValues.delete(LOCK_KEY)
            return Promise.resolve(undefined)
        }),
        moveToFailed: vi.fn().mockResolvedValue(undefined),
        extendLock: vi.fn().mockImplementation((token: string) => Promise.resolve(lockValues.get(LOCK_KEY) === token ? 1 : 0)),
    } as unknown as Job
}

const completion = {
    jobId: JOB_ID,
    token: TOKEN,
    queueName: 'workerJobs',
    status: EngineResponseStatus.OK,
    response: { ok: true },
}

describe('jobBroker lease ownership (#585)', () => {
    let job: Job

    beforeEach(() => {
        vi.clearAllMocks()
        lockValues.clear()
        lockValues.set(LOCK_KEY, TOKEN)
        job = createJob()
        fromId.mockResolvedValue(job)
    })

    describe('completeJob', () => {
        it('finishes the job for the worker that holds it', async () => {
            await jobBroker(log).completeJob(completion)

            expect(job.moveToCompleted).toHaveBeenCalledTimes(1)
            expect(publish).toHaveBeenCalledTimes(1)
            expect(onJobFinished).toHaveBeenCalledTimes(1)
        })

        // The resend a worker makes when the connection dropped after the API had already
        // finished the job: without the guard it would publish INTERNAL_ERROR to the sync caller
        // and release the concurrency slot a second time.
        it('ignores a duplicate of a completion that already landed', async () => {
            await jobBroker(log).completeJob(completion)
            await jobBroker(log).completeJob(completion)

            expect(job.moveToCompleted).toHaveBeenCalledTimes(1)
            expect(job.moveToFailed).not.toHaveBeenCalled()
            expect(publish).toHaveBeenCalledTimes(1)
            expect(onJobFinished).toHaveBeenCalledTimes(1)
        })

        it('ignores a completion from a worker whose job was redelivered to another', async () => {
            lockValues.set(LOCK_KEY, 'token-redelivered')

            await jobBroker(log).completeJob(completion)

            expect(job.moveToCompleted).not.toHaveBeenCalled()
            expect(job.moveToFailed).not.toHaveBeenCalled()
            expect(publish).not.toHaveBeenCalled()
            expect(onJobFinished).not.toHaveBeenCalled()
        })

        // The lock expired or moved between the ownership check and the move itself.
        it.each([
            ['Lock mismatch for job job-1. Cmd moveToFinished from active'],
            ['Missing lock for job job-1. moveToFinished'],
        ])('treats BullMQ refusing the move (%s) like a completion from a worker that lost the job', async (message) => {
            vi.mocked(job.moveToCompleted).mockRejectedValueOnce(new Error(message))
            const errorLog = vi.spyOn(log, 'error')

            await jobBroker(log).completeJob(completion)

            expect(publish).not.toHaveBeenCalled()
            expect(onJobFinished).not.toHaveBeenCalled()
            expect(errorLog).not.toHaveBeenCalled()
        })

        it('still reports any other failure to move the job', async () => {
            vi.mocked(job.moveToCompleted).mockRejectedValueOnce(new Error('Connection is closed.'))

            await jobBroker(log).completeJob(completion)

            expect(publish).toHaveBeenCalledWith('webserver-1', 'req-1', expect.objectContaining({ status: EngineResponseStatus.INTERNAL_ERROR }))
            expect(onJobFinished).toHaveBeenCalledWith(expect.objectContaining({ failed: true }))
        })
    })

    describe('extendLock', () => {
        it('reports the lease as held while the token owns the lock', async () => {
            const result = await jobBroker(log).extendLock({ jobId: JOB_ID, token: TOKEN, queueName: 'workerJobs' })

            expect(result).toEqual({ leaseLost: false })
        })

        it('reports the lease as lost once the lock passed to another token', async () => {
            lockValues.set(LOCK_KEY, 'token-redelivered')

            const result = await jobBroker(log).extendLock({ jobId: JOB_ID, token: TOKEN, queueName: 'workerJobs' })

            expect(result).toEqual({ leaseLost: true })
        })

        it('reports the lease as lost when the job is gone', async () => {
            fromId.mockResolvedValue(null)

            const result = await jobBroker(log).extendLock({ jobId: JOB_ID, token: TOKEN, queueName: 'workerJobs' })

            expect(result).toEqual({ leaseLost: true })
        })
    })
})

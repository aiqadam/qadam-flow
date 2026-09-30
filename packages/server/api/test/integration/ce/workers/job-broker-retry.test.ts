import {
    apId,
    EngineResponseStatus,
    ExecuteFlowJobData,
    ExecutionType,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    RunEnvironment,
    StreamStepProgress,
    WebhookJobData,
    WorkerJobType,
} from '@aiqadam/shared'
import { Queue } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { QueueName } from '../../../../src/app/workers/job'
import { jobBroker } from '../../../../src/app/workers/job-queue/job-broker'
import { jobQueue, JobType } from '../../../../src/app/workers/job-queue/job-queue'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let queue: Queue

beforeAll(async () => {
    app = await setupTestEnvironment()
    await jobBroker(app.log).init()
    queue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
})

afterAll(async () => {
    await queue.close()
    await jobBroker(app.log).close()
    await teardownTestEnvironment()
})

beforeEach(async () => {
    // The CE suite shares one Redis, and poll() pops the queue head: drain what other files leaked.
    await queue.drain(true)
})

describe('Job broker retry by failure class (#584)', () => {
    it('retries a run that failed before execution within seconds, and says so on the redelivery', async () => {
        const jobId = await enqueueExecuteFlowJob()
        const first = await jobBroker(app.log).poll()
        expect(first).toMatchObject({ jobId, attempsStarted: 0, canRetryBeforeExecution: true })

        await jobBroker(app.log).completeJob({ jobId, token: first!.token, queueName: first!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Sandbox did not connect', retryable: true })

        const retried = await queue.getJob(jobId)
        expect(await retried!.getState()).toBe('delayed')
        expect(retried!.attemptsMade).toBe(1)
        expect(retried!.delay).toBeGreaterThanOrEqual(1_000)
        expect(retried!.delay).toBeLessThanOrEqual(2_000)

        const second = await jobBroker(app.log).poll()
        expect(second).toMatchObject({ jobId, attempsStarted: 1, canRetryBeforeExecution: true })
        await jobBroker(app.log).completeJob({ jobId, token: second!.token, queueName: second!.queueName, status: EngineResponseStatus.OK })
    }, 30_000)

    it('never retries a run that failed after the engine received it', async () => {
        const jobId = await enqueueExecuteFlowJob()
        const polled = await jobBroker(app.log).poll()

        await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Worker exited with code 1', retryable: false })

        const failed = await queue.getJob(jobId)
        expect(await failed!.getState()).toBe('failed')
        expect(failed!.attemptsMade).toBe(1)
        expect(failed!.failedReason).toBe('Worker exited with code 1')
        await failed!.remove()
    })

    it('keeps the one retry after 8 minutes for every other job type', async () => {
        const jobId = await enqueueWebhookJob()
        const polled = await jobBroker(app.log).poll()
        expect(polled).toMatchObject({ jobId, canRetryBeforeExecution: false })

        await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'boom' })

        const retried = await queue.getJob(jobId)
        expect(await retried!.getState()).toBe('delayed')
        expect(retried!.opts.backoff).toEqual({ type: 'exponential', delay: 8 * 60 * 1000 })
        expect(retried!.delay).toBe(8 * 60 * 1000)
        await retried!.remove()
    })
})

async function enqueueExecuteFlowJob(): Promise<string> {
    const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
    const id = apId()
    const data: ExecuteFlowJobData = {
        jobType: WorkerJobType.EXECUTE_FLOW,
        executionType: ExecutionType.BEGIN,
        platformId: mockPlatform.id,
        projectId: mockProject.id,
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
        // TESTING skips the project rate limiter, which is not what this file is about.
        environment: RunEnvironment.TESTING,
        flowId: apId(),
        flowVersionId: apId(),
        runId: id,
        payload: { type: 'inline', value: {} },
        streamStepProgress: StreamStepProgress.NONE,
        logsFileId: apId(),
    }
    await jobQueue(app.log).add({ type: JobType.ONE_TIME, id, data })
    return id
}

async function enqueueWebhookJob(): Promise<string> {
    const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
    const data: WebhookJobData = {
        jobType: WorkerJobType.EXECUTE_WEBHOOK,
        platformId: mockPlatform.id,
        projectId: mockProject.id,
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
        requestId: apId(),
        payload: { type: 'inline', value: {} },
        runEnvironment: RunEnvironment.PRODUCTION,
        flowId: apId(),
        saveSampleData: false,
        flowVersionIdToRun: apId(),
        execute: true,
    }
    const id = apId()
    await jobQueue(app.log).add({ type: JobType.ONE_TIME, id, data })
    return id
}

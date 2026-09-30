import {
    apId,
    EngineResponseStatus,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    RunEnvironment,
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
    it('retries a failure before execution within seconds, and says so on the redelivery', async () => {
        const jobId = await enqueueWebhookJob()
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

    it('never retries a failure after the engine received the run', async () => {
        const jobId = await enqueueWebhookJob()
        const polled = await jobBroker(app.log).poll()

        await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Worker exited with code 137', retryable: false })

        const failed = await queue.getJob(jobId)
        expect(await failed!.getState()).toBe('failed')
        expect(failed!.failedReason).toBe('Worker exited with code 137')
        await failed!.remove()
    })

    it('keeps the one retry after 8 minutes for a failure the worker did not classify', async () => {
        const jobId = await enqueueWebhookJob()
        const polled = await jobBroker(app.log).poll()

        await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'boom' })

        const retried = await queue.getJob(jobId)
        expect(await retried!.getState()).toBe('delayed')
        expect(retried!.delay).toBe(8 * 60 * 1000)
        await retried!.remove()
    })
})

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

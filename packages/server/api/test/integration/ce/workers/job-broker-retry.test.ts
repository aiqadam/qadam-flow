import {
    apId,
    EngineResponseStatus,
    ExecuteFlowJobData,
    ExecutionType,
    FlowRetryStrategy,
    FlowRunStatus,
    FlowVersionState,
    isNil,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    RunEnvironment,
    StreamStepProgress,
    WebhookJobData,
    WorkerJobType,
} from '@aiqadam/shared'
import { Job, Queue } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { QueueName } from '../../../../src/app/workers/job'
import { jobBroker } from '../../../../src/app/workers/job-queue/job-broker'
import { jobQueue, JobType } from '../../../../src/app/workers/job-queue/job-queue'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
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

afterEach(() => {
    vi.restoreAllMocks()
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

    it('fails the run on its last attempt, and tells the worker no quick retry is coming', async () => {
        const jobId = await enqueueExecuteFlowJob()
        for (const attempt of [0, 1, 2]) {
            const polled = await jobBroker(app.log).poll()
            expect(polled).toMatchObject({ jobId, attempsStarted: attempt, canRetryBeforeExecution: true })
            await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Sandbox did not connect', retryable: true })
        }

        const last = await jobBroker(app.log).poll()
        expect(last).toMatchObject({ jobId, attempsStarted: 3, canRetryBeforeExecution: false })
        await jobBroker(app.log).completeJob({ jobId, token: last!.token, queueName: last!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Sandbox did not connect', retryable: true })

        const failed = await queue.getJob(jobId)
        expect(await failed!.getState()).toBe('failed')
        expect(failed!.attemptsMade).toBe(4)
        await failed!.remove()
    }, 60_000)

    it('runs a user retry of a run whose job BullMQ kept after failing it for good', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const flowRun = createMockFlowRun({ projectId: ctx.project.id, flowId: flow.id, flowVersionId: flowVersion.id, status: FlowRunStatus.INTERNAL_ERROR, environment: RunEnvironment.TESTING })
        await db.save('flow_run', flowRun)

        await enqueueExecuteFlowJob({ run: { runId: flowRun.id, projectId: ctx.project.id, platformId: ctx.platform.id, flowId: flow.id, flowVersionId: flowVersion.id } })
        const polled = await jobBroker(app.log).poll()
        await jobBroker(app.log).completeJob({ jobId: flowRun.id, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Worker exited with code 1', retryable: false })
        expect(await (await queue.getJob(flowRun.id))!.getState()).toBe('failed')

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, { strategy: FlowRetryStrategy.FROM_FAILED_STEP, projectId: ctx.project.id })
        expect(response.statusCode).toBe(200)

        const requeued = await queue.getJob(flowRun.id)
        expect(await requeued!.getState()).not.toBe('failed')
        expect(requeued!.data).toMatchObject({ executionType: ExecutionType.RESUME, runId: flowRun.id })
        const redelivered = await jobBroker(app.log).poll()
        expect(redelivered).toMatchObject({ jobId: flowRun.id, attempsStarted: 0, canRetryBeforeExecution: true })
        await jobBroker(app.log).completeJob({ jobId: flowRun.id, token: redelivered!.token, queueName: redelivered!.queueName, status: EngineResponseStatus.OK })
    }, 30_000)

    it('leaves a run alone whose job is still in flight', async () => {
        const jobId = await enqueueExecuteFlowJob()
        const polled = await jobBroker(app.log).poll()
        try {
            await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId, platformId: null, replaceDelayed: true })).resolves.toEqual({ alreadyInFlight: true })
            expect(await (await queue.getJob(jobId))!.getState()).toBe('active')
        }
        finally {
            await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.OK })
        }
    })

    it('leaves a run alone that a concurrent retry re-enqueued after this one read the finished job', async () => {
        const { platformId, projectId } = await saveNewProject()
        const run = { runId: apId(), projectId, platformId, flowId: apId(), flowVersionId: apId() }
        await enqueueExecuteFlowJob({ run })
        const polled = await jobBroker(app.log).poll()
        await jobBroker(app.log).completeJob({ jobId: run.runId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Worker exited with code 1', retryable: false })

        const winner = { token: '', queueName: '' }
        vi.spyOn(Job.prototype, 'getState').mockImplementationOnce(async () => {
            await (await queue.getJob(run.runId))!.remove()
            await enqueueExecuteFlowJob({ run })
            const picked = await jobBroker(app.log).poll()
            winner.token = picked!.token
            winner.queueName = picked!.queueName
            return 'failed'
        })
        try {
            await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId: run.runId, platformId, replaceDelayed: true })).resolves.toEqual({ alreadyInFlight: true })
            expect(await (await queue.getJob(run.runId))!.getState()).toBe('active')
        }
        finally {
            await jobBroker(app.log).completeJob({ jobId: run.runId, token: winner.token, queueName: winner.queueName, status: EngineResponseStatus.OK })
        }
    })

    it('rethrows when the finished job it read could not be removed and nothing re-enqueued the run', async () => {
        const jobId = await enqueueExecuteFlowJob()
        const polled = await jobBroker(app.log).poll()
        vi.spyOn(Job.prototype, 'getState').mockResolvedValueOnce('failed')
        try {
            await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId, platformId: null, replaceDelayed: true })).rejects.toThrow('locked by another worker')
        }
        finally {
            await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.OK })
        }
    })

    it('replaces a delayed automatic retry of a run that already ended with the user retry', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const flowRun = createMockFlowRun({ projectId: ctx.project.id, flowId: flow.id, flowVersionId: flowVersion.id, status: FlowRunStatus.INTERNAL_ERROR, environment: RunEnvironment.TESTING })
        await db.save('flow_run', flowRun)
        // What a pre-#584 job looks like after it reported INTERNAL_ERROR: its BEGIN retry is 8 minutes away.
        await enqueueExecuteFlowJob({ run: { runId: flowRun.id, projectId: ctx.project.id, platformId: ctx.platform.id, flowId: flow.id, flowVersionId: flowVersion.id }, delay: 8 * 60 * 1000 })
        expect(await (await queue.getJob(flowRun.id))!.getState()).toBe('delayed')

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, { strategy: FlowRetryStrategy.FROM_FAILED_STEP, projectId: ctx.project.id })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ id: flowRun.id, status: FlowRunStatus.QUEUED })

        const requeued = await queue.getJob(flowRun.id)
        expect(['waiting', 'prioritized']).toContain(await requeued!.getState())
        expect(requeued!.data).toMatchObject({ executionType: ExecutionType.RESUME, runId: flowRun.id })
        const redelivered = await jobBroker(app.log).poll()
        expect(redelivered).toMatchObject({ jobId: flowRun.id, attempsStarted: 0 })
        await jobBroker(app.log).completeJob({ jobId: flowRun.id, token: redelivered!.token, queueName: redelivered!.queueName, status: EngineResponseStatus.OK })
    }, 30_000)

    it('leaves a delayed job alone when the run has not ended', async () => {
        const jobId = await enqueueExecuteFlowJob({ delay: 60_000 })
        try {
            await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId, platformId: null, replaceDelayed: false })).resolves.toEqual({ alreadyInFlight: true })
            expect(await (await queue.getJob(jobId))!.getState()).toBe('delayed')
        }
        finally {
            await (await queue.getJob(jobId))?.remove()
        }
    })

    it('lets the retry through when the job went away between the two reads', async () => {
        const jobId = await enqueueFailedExecuteFlowJob()
        vi.spyOn(Job.prototype, 'getState').mockImplementationOnce(async () => {
            await (await queue.getJob(jobId))!.remove()
            return 'unknown'
        })

        await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId, platformId: null, replaceDelayed: true })).resolves.toEqual({ alreadyInFlight: false })
        expect(await queue.getJob(jobId)).toBeUndefined()
    })

    it('removes a job hash that no state list holds any more, so the retry can enqueue the id again', async () => {
        const jobId = await enqueueFailedExecuteFlowJob()
        const client = await queue.client
        await client.zrem(queue.toKey('failed'), jobId)
        expect(await (await queue.getJob(jobId))!.getState()).toBe('unknown')

        await expect(jobQueue(app.log).removeFinishedOneTimeJob({ jobId, platformId: null, replaceDelayed: true })).resolves.toEqual({ alreadyInFlight: false })
        expect(await queue.getJob(jobId)).toBeUndefined()
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

async function enqueueExecuteFlowJob({ run, delay }: EnqueueExecuteFlowJobParams = {}): Promise<string> {
    const { platformId, projectId } = isNil(run) ? await saveNewProject() : run
    const id = run?.runId ?? apId()
    const data: ExecuteFlowJobData = {
        jobType: WorkerJobType.EXECUTE_FLOW,
        executionType: ExecutionType.BEGIN,
        platformId,
        projectId,
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
        // TESTING skips the project rate limiter, which is not what this file is about.
        environment: RunEnvironment.TESTING,
        flowId: run?.flowId ?? apId(),
        flowVersionId: run?.flowVersionId ?? apId(),
        runId: id,
        payload: { type: 'inline', value: {} },
        streamStepProgress: StreamStepProgress.NONE,
        logsFileId: apId(),
    }
    await jobQueue(app.log).add({ type: JobType.ONE_TIME, id, data, delay })
    return id
}

async function enqueueFailedExecuteFlowJob(): Promise<string> {
    const jobId = await enqueueExecuteFlowJob()
    const polled = await jobBroker(app.log).poll()
    await jobBroker(app.log).completeJob({ jobId, token: polled!.token, queueName: polled!.queueName, status: EngineResponseStatus.INTERNAL_ERROR, errorMessage: 'Worker exited with code 1', retryable: false })
    return jobId
}

async function saveNewProject(): Promise<{ platformId: string, projectId: string }> {
    const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
    return { platformId: mockPlatform.id, projectId: mockProject.id }
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

type EnqueueExecuteFlowJobParams = {
    run?: ExistingRun
    delay?: number
}

type ExistingRun = {
    runId: string
    projectId: string
    platformId: string
    flowId: string
    flowVersionId: string
}

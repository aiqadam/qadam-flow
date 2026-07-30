import {
    apId,
    ExecuteFlowJobData,
    ExecutionType,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    RunEnvironment,
    StreamStepProgress,
    WorkerJobType,
} from '@aiqadam/shared'
import { Queue, Worker } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { tryDequeue } from '../../../../src/app/workers/job-queue/job-broker'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('jobBroker.tryDequeue — invalid-schema poison handling', () => {
    // Exercises tryDequeue directly on a dedicated queue rather than jobBroker.poll()
    // on the shared WORKER_JOBS queue: the CE suite shares one Redis (so other tests
    // leak jobs into WORKER_JOBS), and poll() only resolves null via its 50s waiter
    // timeout once the poison job is failed internally. A per-test queue with a short
    // drainDelay keeps this deterministic and fast.
    it('fails the job as unrecoverable when migrated data still fails JobData.parse, instead of recycling', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()

        const queueName = `test-poison-${apId()}`
        const queue = new Queue(queueName, { connection: await redisConnections.create() })
        const worker = new Worker(queueName, undefined, {
            connection: await redisConnections.create(),
            autorun: false,
            drainDelay: 1,
            lockDuration: 120_000,
        })
        await queue.waitUntilReady()
        await worker.waitUntilReady()

        try {
            const validJobData: ExecuteFlowJobData = {
                jobType: WorkerJobType.EXECUTE_FLOW,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                projectId: mockProject.id,
                platformId: mockPlatform.id,
                flowId: apId(),
                flowVersionId: apId(),
                runId: apId(),
                environment: RunEnvironment.PRODUCTION,
                executionType: ExecutionType.BEGIN,
                streamStepProgress: StreamStepProgress.NONE,
                payload: { type: 'inline', value: null },
                logsFileId: apId(),
            }

            const jobId = apId()
            await queue.add(WorkerJobType.EXECUTE_FLOW, validJobData, { jobId })

            const redis = await redisConnections.useExisting()

            // Corrupt the persisted payload after enqueue: valid schemaVersion, but
            // missing required fields, so jobMigrations leaves it untouched and
            // JobData.parse rejects it — the "poison after migration" case.
            const poisonedRaw = JSON.stringify({
                jobType: WorkerJobType.EXECUTE_FLOW,
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                projectId: mockProject.id,
                platformId: mockPlatform.id,
                runId: apId(),
                executionType: 'BEGIN',
            })
            await redis.hset(`bull:${queueName}:${jobId}`, 'data', poisonedRaw)

            const dequeued = await tryDequeue(worker, queueName, app.log)

            expect(dequeued).toBeNull()

            const failedAfter = await redis.zrange(`bull:${queueName}:failed`, 0, -1)
            const activeAfter = await redis.lrange(`bull:${queueName}:active`, 0, -1)
            const waitAfter = await redis.lrange(`bull:${queueName}:wait`, 0, -1)

            expect(failedAfter).toContain(jobId)
            expect(activeAfter).not.toContain(jobId)
            expect(waitAfter).not.toContain(jobId)

            const failedReason = await redis.hget(`bull:${queueName}:${jobId}`, 'failedReason')
            expect(failedReason).toContain('Job data failed schema validation after migration')
        }
        finally {
            await worker.close()
            await queue.obliterate({ force: true })
            await queue.close()
        }
    })
})

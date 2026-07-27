import { ExecutionType, RunEnvironment, StreamStepProgress, WorkerJobType } from '@aiqadam/shared'
import { Job } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getConcurrencyPoolSetKey, getProjectMaxConcurrentJobsKey } from '../../../../src/app/database/redis/keys'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { projectRepo } from '../../../../src/app/project/project-repo'
import { rateLimiterInterceptor } from '../../../../src/app/workers/job-queue/interceptors/rate-limiter-interceptor'
import { InterceptorVerdict } from '../../../../src/app/workers/job-queue/job-interceptor'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let defaultConcurrentJobsLimit = 100
let flowTimeoutSeconds = 600

/**
 * Runs `rateLimiterInterceptor` against a real Redis (the CE integration DB/Redis, not
 * the in-memory fakes the unit-test file for this interceptor uses). This file starts
 * with #201's project-level `maxConcurrentJobs` override, which needs the live Redis
 * because the override lookup goes through the real `distributedStore` cache.
 */
describe('rateLimiterInterceptor (CE, real Redis)', () => {
    beforeAll(async () => {
        app = await setupTestEnvironment({ fresh: true })
        vi.spyOn(system, 'getBoolean').mockImplementation((prop) => {
            if (prop === AppSystemProp.PROJECT_RATE_LIMITER_ENABLED) return true
            return undefined
        })
        vi.spyOn(system, 'getNumberOrThrow').mockImplementation((prop) => {
            if (prop === AppSystemProp.FLOW_TIMEOUT_SECONDS) return flowTimeoutSeconds
            if (prop === AppSystemProp.DEFAULT_CONCURRENT_JOBS_LIMIT) return defaultConcurrentJobsLimit
            throw new Error(`unexpected system prop in test: ${prop}`)
        })
    })

    afterEach(() => {
        defaultConcurrentJobsLimit = 100
        flowTimeoutSeconds = 600
    })

    afterAll(async () => {
        vi.restoreAllMocks()
        await teardownTestEnvironment()
    })

    function createJobData(overrides: { projectId: string, platformId: string }) {
        return {
            jobType: WorkerJobType.EXECUTE_FLOW,
            environment: RunEnvironment.PRODUCTION,
            schemaVersion: 4,
            flowId: `flow-${crypto.randomUUID()}`,
            flowVersionId: `fv-${crypto.randomUUID()}`,
            runId: `run-${crypto.randomUUID()}`,
            executionType: ExecutionType.BEGIN,
            streamStepProgress: StreamStepProgress.NONE,
            payload: {},
            logsUploadUrl: 'http://localhost/logs',
            logsFileId: 'log-file-id',
            ...overrides,
        }
    }

    function createMockJob(attemptsMade = 0): Job {
        return { attemptsMade } as unknown as Job
    }

    async function cleanupPool(projectId: string): Promise<void> {
        const redis = await redisConnections.useExisting()
        await redis.del(getConcurrencyPoolSetKey(projectId))
        await redis.del(getProjectMaxConcurrentJobsKey(projectId))
    }

    describe('#201 — project-level maxConcurrentJobs override', () => {
        it('enforces a project cap lower than the platform default', async () => {
            defaultConcurrentJobsLimit = 100
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            // `createMockProject` (test/helpers/mocks) does not thread `maxConcurrentJobs`
            // through from its `Partial<Project>` param — it silently drops it — so the
            // override has to be written directly against the repo, not via the mock helper.
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 1 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const first = await rateLimiterInterceptor.preDispatch({ jobId: 'override-1', jobData, job: createMockJob(), log: app.log })
            expect(first.verdict).toBe(InterceptorVerdict.ALLOW)

            const second = await rateLimiterInterceptor.preDispatch({ jobId: 'override-2', jobData, job: createMockJob(), log: app.log })
            expect(second.verdict).toBe(InterceptorVerdict.REJECT)

            await cleanupPool(mockProject.id)
        })

        it('falls back to the platform default when the project has no override', async () => {
            defaultConcurrentJobsLimit = 2
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const r1 = await rateLimiterInterceptor.preDispatch({ jobId: 'fallback-1', jobData, job: createMockJob(), log: app.log })
            const r2 = await rateLimiterInterceptor.preDispatch({ jobId: 'fallback-2', jobData, job: createMockJob(), log: app.log })
            const r3 = await rateLimiterInterceptor.preDispatch({ jobId: 'fallback-3', jobData, job: createMockJob(), log: app.log })

            expect(r1.verdict).toBe(InterceptorVerdict.ALLOW)
            expect(r2.verdict).toBe(InterceptorVerdict.ALLOW)
            expect(r3.verdict).toBe(InterceptorVerdict.REJECT)

            await cleanupPool(mockProject.id)
        })

        it('caches the resolved override for the hot path — a DB-only change is not observed until the cache entry expires', async () => {
            defaultConcurrentJobsLimit = 100
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 1 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const first = await rateLimiterInterceptor.preDispatch({ jobId: 'cache-1', jobData, job: createMockJob(), log: app.log })
            expect(first.verdict).toBe(InterceptorVerdict.ALLOW)

            // Bypass the service layer entirely — a raw repo update, so nothing invalidates
            // the cache written by the call above.
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: null })

            // Still enforces the cached value (1), not the just-written DB value (null ->
            // platform default of 100), because the TTL has not elapsed.
            const second = await rateLimiterInterceptor.preDispatch({ jobId: 'cache-2', jobData, job: createMockJob(), log: app.log })
            expect(second.verdict).toBe(InterceptorVerdict.REJECT)

            await cleanupPool(mockProject.id)
        })
    })
})

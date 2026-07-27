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
 * the in-memory fakes the unit-test file for this interceptor uses). The unit-test file
 * (test/unit/.../rate-limiter-interceptor.test.ts) mocks `redis.eval` with a fake that
 * *reimplements* the Lua rather than running it — see the comment on that fake, and #199
 * — so neither hand-written script (`tryAcquireSlot`, `releaseSlot`) is exercised for
 * real anywhere else. This file also covers #201's project-level `maxConcurrentJobs`
 * override, which independently needs the live Redis because the override lookup goes
 * through the real `distributedStore` cache, not the in-memory fake.
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

    describe('#199 — the real Lua scripts (dedup, capacity, eviction)', () => {
        it('dedups the same jobId — second acquire for an identical jobId does not add a second ZSET member', async () => {
            defaultConcurrentJobsLimit = 5
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const r1 = await rateLimiterInterceptor.preDispatch({ jobId: 'dup-job', jobData, job: createMockJob(), log: app.log })
            const r2 = await rateLimiterInterceptor.preDispatch({ jobId: 'dup-job', jobData, job: createMockJob(), log: app.log })
            expect(r1.verdict).toBe(InterceptorVerdict.ALLOW)
            expect(r2.verdict).toBe(InterceptorVerdict.ALLOW)

            const redis = await redisConnections.useExisting()
            const members = await redis.zrange(getConcurrencyPoolSetKey(mockProject.id), 0, -1)
            expect(members).toHaveLength(1)

            await cleanupPool(mockProject.id)
        })

        it('rejects once the real ZCARD check hits the configured limit', async () => {
            defaultConcurrentJobsLimit = 2
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const r1 = await rateLimiterInterceptor.preDispatch({ jobId: 'cap-1', jobData, job: createMockJob(), log: app.log })
            const r2 = await rateLimiterInterceptor.preDispatch({ jobId: 'cap-2', jobData, job: createMockJob(), log: app.log })
            const r3 = await rateLimiterInterceptor.preDispatch({ jobId: 'cap-3', jobData, job: createMockJob(), log: app.log })

            expect(r1.verdict).toBe(InterceptorVerdict.ALLOW)
            expect(r2.verdict).toBe(InterceptorVerdict.ALLOW)
            expect(r3.verdict).toBe(InterceptorVerdict.REJECT)

            await cleanupPool(mockProject.id)
        })

        it('releaseSlot ZREMs the member, freeing capacity for the next acquire', async () => {
            defaultConcurrentJobsLimit = 1
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            await rateLimiterInterceptor.preDispatch({ jobId: 'rel-1', jobData, job: createMockJob(), log: app.log })
            const blocked = await rateLimiterInterceptor.preDispatch({ jobId: 'rel-2', jobData, job: createMockJob(), log: app.log })
            expect(blocked.verdict).toBe(InterceptorVerdict.REJECT)

            await rateLimiterInterceptor.onJobFinished({ jobId: 'rel-1', jobData, failed: false, log: app.log })

            const afterRelease = await rateLimiterInterceptor.preDispatch({ jobId: 'rel-3', jobData, job: createMockJob(), log: app.log })
            expect(afterRelease.verdict).toBe(InterceptorVerdict.ALLOW)

            await cleanupPool(mockProject.id)
        })

        it('the acquire script evicts stale ZSET members older than timeoutMs before checking capacity', async () => {
            defaultConcurrentJobsLimit = 1
            flowTimeoutSeconds = 1 // timeoutMs = (1s + 1min), so anything older than ~61s is stale
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const redis = await redisConnections.useExisting()
            const setKey = getConcurrencyPoolSetKey(mockProject.id)
            const staleTimestamp = Date.now() - 120_000
            await redis.zadd(setKey, staleTimestamp, `${mockProject.id}:stale-job`)

            // Pool reads as "at capacity" (1 stale member, limit 1) unless the real Lua's
            // ZREMRANGEBYSCORE actually runs against Redis and evicts it first.
            const result = await rateLimiterInterceptor.preDispatch({ jobId: 'fresh-job', jobData, job: createMockJob(), log: app.log })
            expect(result.verdict).toBe(InterceptorVerdict.ALLOW)

            const members = await redis.zrange(setKey, 0, -1)
            expect(members).toEqual([`${mockProject.id}:fresh-job`])

            await cleanupPool(mockProject.id)
        })
    })

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

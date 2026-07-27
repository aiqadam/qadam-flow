import { ExecutionType, RunEnvironment, StreamStepProgress, WorkerJobType } from '@aiqadam/shared'
import { Job } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getConcurrencyPoolSetKey, getProjectMaxConcurrentJobsKey } from '../../../../src/app/database/redis/keys'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { projectRepo } from '../../../../src/app/project/project-repo'
import * as projectServiceModule from '../../../../src/app/project/project-service'
import { projectService } from '../../../../src/app/project/project-service'
import { rateLimiterInterceptor } from '../../../../src/app/workers/job-queue/interceptors/rate-limiter-interceptor'
import { InterceptorVerdict } from '../../../../src/app/workers/job-queue/job-interceptor'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let defaultConcurrentJobsLimit = 100
let flowTimeoutSeconds = 600
let currentProjectId: string | undefined

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
        // Falls through to the real implementation for any prop other than the two this suite
        // drives — throwing here (as an earlier revision did) means any background code path
        // that reads a third system prop while the app is live surfaces as an unrelated
        // unhandled rejection instead of a clear test failure.
        const originalGetNumberOrThrow = system.getNumberOrThrow.bind(system)
        vi.spyOn(system, 'getNumberOrThrow').mockImplementation((prop) => {
            if (prop === AppSystemProp.FLOW_TIMEOUT_SECONDS) return flowTimeoutSeconds
            if (prop === AppSystemProp.DEFAULT_CONCURRENT_JOBS_LIMIT) return defaultConcurrentJobsLimit
            return originalGetNumberOrThrow(prop)
        })
    })

    afterEach(async () => {
        defaultConcurrentJobsLimit = 100
        flowTimeoutSeconds = 600
        // Runs even when the test's own assertions throw first — cleanup living at the end of
        // each `it` instead meant a failing assertion skipped it and leaked stale
        // `active_jobs_set:pool:*` keys into the shared Redis for later tests/files to trip over.
        if (currentProjectId) {
            await cleanupPool(currentProjectId)
            currentProjectId = undefined
        }
    })

    afterAll(async () => {
        vi.restoreAllMocks()
        await teardownTestEnvironment()
    })

    function createJobData(overrides: { projectId: string, platformId: string }) {
        currentProjectId = overrides.projectId
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

    // `Job` (bullmq) has `attemptsMade` as a real member alongside many others the interceptor
    // never reads, so `Job` is itself assignable to `{ attemptsMade: number }` — that overlap is
    // enough for TypeScript to allow this as a single-step assertion, no `unknown` bridge needed.
    function createMockJob(attemptsMade = 0): Job {
        return { attemptsMade } as Job
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
        })

        // The create/update schemas reject 0 and negative values (packages/shared), but this
        // runtime guard is the second line of defence for a value that reaches the column some
        // other way — a non-positive `maxJobs` makes the Lua's `currentSize >= maxJobs` true
        // unconditionally, which would permanently block every dispatch for the project.
        it('treats a non-positive project override already in the DB as "no override", not as a permanent block', async () => {
            defaultConcurrentJobsLimit = 3
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 0 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const result = await rateLimiterInterceptor.preDispatch({ jobId: 'non-positive-1', jobData, job: createMockJob(), log: app.log })
            expect(result.verdict).toBe(InterceptorVerdict.ALLOW)
        })

        // preDispatch runs inside tryDequeue *after* the job has already been moved to `active`
        // — a throw here would strand it there with no way back to the queue until BullMQ's
        // stalled scan reclaims it, and a second stall fails the run outright. A transient
        // Postgres/Redis blip must fall back to the platform default, not propagate.
        it('falls back to the platform default, without throwing, when the project lookup itself throws', async () => {
            defaultConcurrentJobsLimit = 7
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 1 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const originalProjectService = projectServiceModule.projectService
            const projectServiceSpy = vi.spyOn(projectServiceModule, 'projectService').mockImplementation((log) => ({
                ...originalProjectService(log),
                getOne: vi.fn().mockRejectedValue(new Error('simulated Postgres blip')),
            }))

            try {
                // If the throw propagated, `preDispatch` itself would reject instead of
                // resolving — assert it resolves at all, then that it used the platform
                // default (7) rather than the DB's override (1), which the throw prevented
                // it from ever reading.
                const results = []
                for (let i = 0; i < 7; i++) {
                    results.push(await rateLimiterInterceptor.preDispatch({ jobId: `blip-${i}`, jobData, job: createMockJob(), log: app.log }))
                }
                expect(results.every((r) => r.verdict === InterceptorVerdict.ALLOW)).toBe(true)

                const eighth = await rateLimiterInterceptor.preDispatch({ jobId: 'blip-8', jobData, job: createMockJob(), log: app.log })
                expect(eighth.verdict).toBe(InterceptorVerdict.REJECT)
            }
            finally {
                // .mockRestore() (not vi.restoreAllMocks()) — this suite's beforeAll spies on
                // system.getBoolean/getNumberOrThrow for its whole lifetime; a blanket restore
                // here would silently undo those for every test that runs after this one.
                projectServiceSpy.mockRestore()
            }
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
        })

        // This is the headline trade-off of the whole design (a short-TTL cache instead of a
        // per-job Postgres read) — assert it directly against real Redis rather than only
        // inferring it from behaviour. A prior revision dropped the TTL argument entirely
        // (making the cache permanent, so a changed limit would never take effect) and every
        // other test in this file still passed, because none of them asserted on the TTL itself.
        it('stores the cache entry with a bounded TTL, not permanently', async () => {
            defaultConcurrentJobsLimit = 100
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 1 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            await rateLimiterInterceptor.preDispatch({ jobId: 'ttl-1', jobData, job: createMockJob(), log: app.log })

            const redis = await redisConnections.useExisting()
            const ttlMs = await redis.pttl(getProjectMaxConcurrentJobsKey(mockProject.id))
            expect(ttlMs).toBeGreaterThan(0)
            expect(ttlMs).toBeLessThanOrEqual(30_000)
        })

        it('invalidates the cache immediately when the project is updated through the service, unlike a raw DB write', async () => {
            defaultConcurrentJobsLimit = 100
            const { mockOwner, mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            await projectRepo().update({ id: mockProject.id }, { maxConcurrentJobs: 1 })
            const jobData = createJobData({ projectId: mockProject.id, platformId: mockPlatform.id })

            const first = await rateLimiterInterceptor.preDispatch({ jobId: 'invalidate-1', jobData, job: createMockJob(), log: app.log })
            expect(first.verdict).toBe(InterceptorVerdict.ALLOW)

            await projectService(app.log).update({
                projectId: mockProject.id,
                platformId: mockPlatform.id,
                userId: mockOwner.id,
                isPrivileged: true,
                request: { type: mockProject.type, maxConcurrentJobs: null },
            })

            // The cap is now unlimited (falls back to the platform default of 100) without
            // waiting out the 30s TTL, because project-service.ts's update deletes the cache
            // key on the same write.
            const second = await rateLimiterInterceptor.preDispatch({ jobId: 'invalidate-2', jobData, job: createMockJob(), log: app.log })
            expect(second.verdict).toBe(InterceptorVerdict.ALLOW)
        })
    })
})

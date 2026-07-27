import { apDayjsDuration } from '@aiqadam/server-utils'
import { ExecuteFlowJobData, isNil, JOB_PRIORITY, JobData, PlatformId, ProjectId, RATE_LIMIT_PRIORITY, RunEnvironment, tryCatch, WorkerJobType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { getConcurrencyPoolSetKey, getProjectMaxConcurrentJobsKey } from '../../../database/redis/keys'
import { distributedStore, redisConnections } from '../../../database/redis-connections'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { projectService } from '../../../project/project-service'
import { InterceptorResult, InterceptorVerdict, JobInterceptor } from '../job-interceptor'

const RATE_LIMIT_WORKER_JOB_TYPES = [WorkerJobType.EXECUTE_FLOW]

// preDispatch runs on every job, so a per-job Postgres read for the project's override is off
// the table. The value rarely changes, so a short-TTL redis cache (same distributedStore + TTL
// pattern as flow-execution-cache.ts) bounds staleness to this window as a backstop; the actual
// invalidation path is project-service.ts's update deleting the cache key on write, so an
// operator lowering a cap for incident response does not have to wait out the TTL.
const PROJECT_MAX_CONCURRENT_JOBS_CACHE_TTL_SECONDS = 30

function shouldContinue(jobData: JobData): jobData is ExecuteFlowJobData {
    if (!system.getBoolean(AppSystemProp.PROJECT_RATE_LIMITER_ENABLED)) {
        return false
    }
    if (!RATE_LIMIT_WORKER_JOB_TYPES.includes(jobData.jobType)) {
        return false
    }
    const castedJob = jobData as ExecuteFlowJobData
    if (castedJob.environment === RunEnvironment.TESTING) {
        return false
    }
    return true
}


async function getMaxConcurrentJobsForPlatformPlan(_params: { platformId: PlatformId }): Promise<number> {
    return system.getNumberOrThrow(AppSystemProp.DEFAULT_CONCURRENT_JOBS_LIMIT)
}

// `project.maxConcurrentJobs` is the per-project override a *privileged* caller sets via
// POST /v1/projects (create) or POST /v1/projects/:id (update) — project-service.ts rejects a
// non-nil value from anyone else. `null`/`undefined` means "no override" — fall back to the
// platform-wide default, same as before this project-level cap existed. A non-positive value is
// also treated as "no override": the create/update schemas already reject it, but the runtime
// check is kept as a second line of defence (schema and runtime should not both be load-bearing
// for the same invariant) — a non-positive `maxJobs` makes the Lua's `currentSize >= maxJobs`
// true unconditionally, permanently blocking every dispatch for that project.
async function getProjectMaxConcurrentJobsOverride({ projectId, log }: { projectId: ProjectId, log: FastifyBaseLogger }): Promise<number | null> {
    const { data, error } = await tryCatch(async () => {
        const cacheKey = getProjectMaxConcurrentJobsKey(projectId)
        const cached = await distributedStore.get<{ maxConcurrentJobs: number | null }>(cacheKey)
        if (!isNil(cached)) {
            return cached.maxConcurrentJobs
        }

        const project = await projectService(log).getOne(projectId)
        const maxConcurrentJobs = project?.maxConcurrentJobs ?? null
        await distributedStore.put(cacheKey, { maxConcurrentJobs }, PROJECT_MAX_CONCURRENT_JOBS_CACHE_TTL_SECONDS)
        return maxConcurrentJobs
    })

    if (!isNil(error)) {
        // This runs inside tryDequeue, after the job has already been moved to `active` — a
        // throw here would strand it there with no way back to the queue until BullMQ's stalled
        // scan reclaims it (and a second stall would fail the run outright). Falling back to the
        // platform default on a Postgres/Redis blip is exactly the pre-#201 behaviour, and briefly
        // under-enforcing a cap is strictly better than failing someone's run.
        log.warn({ projectId, err: error }, '[rateLimiterInterceptor] Failed to read project maxConcurrentJobs override, falling back to platform default')
        return null
    }

    if (isNil(data) || data <= 0) {
        return null
    }
    return data
}

async function getMaxConcurrentJobs({ platformId, projectId, log }: { platformId: PlatformId, projectId: ProjectId, log: FastifyBaseLogger }): Promise<number> {
    const projectOverride = await getProjectMaxConcurrentJobsOverride({ projectId, log })
    if (!isNil(projectOverride)) {
        return projectOverride
    }
    return getMaxConcurrentJobsForPlatformPlan({ platformId })
}

async function tryAcquireSlot({ jobId, jobData, log }: { jobId: string, jobData: ExecuteFlowJobData, log: FastifyBaseLogger }): Promise<boolean> {
    const flowTimeoutInMilliseconds = apDayjsDuration(system.getNumberOrThrow(AppSystemProp.FLOW_TIMEOUT_SECONDS), 'seconds').add(1, 'minute').asMilliseconds()
    const effectivePoolId = jobData.projectId
    const maxConcurrentJobs = await getMaxConcurrentJobs({
        platformId: jobData.platformId,
        projectId: jobData.projectId,
        log,
    })
    const setKey = getConcurrencyPoolSetKey(effectivePoolId)
    const currentTime = Date.now()
    const member = `${jobData.projectId}:${jobId}`
    const redisConnection = await redisConnections.useExisting()

    const result = await redisConnection.eval(
        `
local setKey = KEYS[1]
local currentTime = tonumber(ARGV[1])
local timeoutMs = tonumber(ARGV[2])
local maxJobs = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', setKey, '-inf', currentTime - timeoutMs)

local existingScore = redis.call('ZSCORE', setKey, member)
if existingScore then
    return 0
end

local currentSize = redis.call('ZCARD', setKey)
if currentSize >= maxJobs then
    return 1
end

redis.call('ZADD', setKey, currentTime, member)
redis.call('EXPIRE', setKey, math.ceil(timeoutMs / 1000))

return 0
`,
        1,
        setKey,
        currentTime.toString(),
        flowTimeoutInMilliseconds.toString(),
        maxConcurrentJobs.toString(),
        member,
    ) as number

    return result === 0
}

async function releaseSlot({ jobId, jobData, log: _log }: { jobId: string, jobData: ExecuteFlowJobData, log: FastifyBaseLogger }): Promise<void> {
    const effectivePoolId = jobData.projectId
    const setKey = getConcurrencyPoolSetKey(effectivePoolId)
    const member = `${jobData.projectId}:${jobId}`
    const redisConnection = await redisConnections.useExisting()
    await redisConnection.eval(
        `
local setKey = KEYS[1]
local member = ARGV[1]
redis.call('ZREM', setKey, member)
return 1
`,
        1,
        setKey,
        member,
    )
}

export const rateLimiterInterceptor: JobInterceptor = {
    async preDispatch({ jobId, jobData, job, log }): Promise<InterceptorResult> {
        if (!shouldContinue(jobData)) {
            return { verdict: InterceptorVerdict.ALLOW }
        }

        const allowed = await tryAcquireSlot({ jobId, jobData, log })
        if (allowed) {
            log.debug({ jobId, projectId: jobData.projectId }, '[rateLimiterInterceptor] Job allowed')
            return { verdict: InterceptorVerdict.ALLOW }
        }

        const delayInMs = Math.min(600_000, 20_000 * Math.pow(2, job.attemptsMade))
        log.info({ jobId, projectId: jobData.projectId, delayInMs }, '[rateLimiterInterceptor] Job rate limited')
        return {
            verdict: InterceptorVerdict.REJECT,
            delayInMs,
            priority: JOB_PRIORITY[RATE_LIMIT_PRIORITY],
        }
    },

    async onJobFinished({ jobId, jobData, log }): Promise<void> {
        if (!shouldContinue(jobData)) {
            return
        }
        await releaseSlot({ jobId, jobData, log })
        log.debug({ jobId, projectId: jobData.projectId }, '[rateLimiterInterceptor] Slot released')
    },
}

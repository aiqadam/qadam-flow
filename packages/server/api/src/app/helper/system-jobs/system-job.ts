import { apDayjs, apDayjsDuration } from '@aiqadam/server-utils'
import { assertNotNullOrUndefined, isNil, tryCatch } from '@aiqadam/shared'
import { Job, JobSchedulerJson, JobsOptions, Queue, Worker } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import { redisConnections } from '../../database/redis-connections'
import { exceptionHandler } from '../exception-handler'
import { DEPRECATED_SYSTEM_JOB_NAMES, JobSchedule, SystemJobData, SystemJobName, SystemJobSchedule } from './common'
import { systemJobHandlers } from './job-handlers'

const FIFTEEN_MINUTES = apDayjsDuration(15, 'minute').asMilliseconds()
const ONE_MONTH = apDayjsDuration(1, 'month').asSeconds()
const SYSTEM_JOB_QUEUE = 'system-job-queue'

export let systemJobsQueue: Queue<SystemJobData, unknown, SystemJobName>
let systemJobWorker: Worker<SystemJobData, unknown, SystemJobName>

export const systemJobsSchedule = (log: FastifyBaseLogger): SystemJobSchedule => ({
    async init(): Promise<void> {
        const queueConfig = {
            connection: await redisConnections.create(),
            defaultJobOptions: {
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: FIFTEEN_MINUTES,
                },
                removeOnComplete: true,
                removeOnFail: {
                    age: ONE_MONTH,
                },
            },
        }

        systemJobsQueue = new Queue(SYSTEM_JOB_QUEUE, queueConfig)
        await systemJobsQueue.waitUntilReady()

        const { error } = await tryCatch(async () => removeDeprecatedJobs())
        if (!isNil(error)) {
            log.error({ err: error }, '[systemJob#init] Error removing deprecated jobs')
        }
    },

    async startWorker(): Promise<void> {
        systemJobWorker = new Worker(
            SYSTEM_JOB_QUEUE,
            async (job) => {
                if (isDeprecatedJobName(job.name)) {
                    log.info({ jobName: job.name, jobId: job.id }, '[systemJob#worker] Dropping job with a deprecated name')
                    return
                }
                log.debug({ jobName: job.name }, '[systemJob#worker] Executing job')

                const jobHandler = systemJobHandlers.getJobHandler(job.name)
                await jobHandler(job.data)
            },
            {
                connection: await redisConnections.create(),
                concurrency: 5,
            },
        )

        systemJobWorker.on('failed', (job, err) => {
            const attemptsUsed = job?.attemptsMade ?? 0
            const maxAttempts = job?.opts?.attempts ?? Infinity
            if (attemptsUsed >= maxAttempts) {
                exceptionHandler.handle(err, log)
            }
        })

        await systemJobWorker.waitUntilReady()
    },

    async upsertJob({ job, schedule, customConfig }): Promise<void> {
        log.info({ jobName: job.name }, '[systemJob#upsertJob] Upserting job')
        const existingJob = await getJobByNameAndJobId(job.name, job.jobId)

        const patternChanged = !isNil(existingJob) && schedule.type === 'repeated' ? schedule.cron !== existingJob.opts.repeat?.pattern : false

        if (patternChanged && !isNil(existingJob) && !isNil(existingJob.opts.repeat) && !isNil(existingJob.name)) {
            log.info({ jobName: job.name }, '[systemJob#upsertJob] Pattern changed, removing job from queue')
            await systemJobsQueue.removeRepeatable(existingJob.name as SystemJobName, existingJob.opts.repeat)
        }
        if (!isNil(existingJob) && await existingJob.isFailed()) {
            log.info({ jobName: job.name }, '[systemJob#upsertJob] Retrying failed job')
            await existingJob.retry()
        }
        if (isNil(existingJob) || patternChanged) {
            log.info({ jobName: job.name }, '[systemJob#upsertJob] Adding job to queue')
            const jobOptions = configureJobOptions({ schedule, jobId: job.jobId, customConfig })
            await systemJobsQueue.add(job.name, job.data, jobOptions)
            return
        }
    },

    async getJob<T extends SystemJobName>(jobId: string) {
        return await systemJobsQueue.getJob(jobId) as Job<SystemJobData<T>> | undefined
    },

    async close(): Promise<void> {
        if (isNil(systemJobsQueue)) {
            return
        }

        await Promise.all([
            systemJobsQueue.close(),
            systemJobWorker?.close(),
        ])
    },
})

async function removeDeprecatedJobs(): Promise<void> {
    const knownJobNames: string[] = Object.values(SystemJobName)
    const allSystemJobs = await systemJobsQueue.getJobSchedulers()
    const staleSchedulers = allSystemJobs.filter(f => {
        if (isNil(f)) {
            return false
        }
        const name = getSchedulerJobName(f)
        return isDeprecatedJobName(name) || (knownJobNames.includes(name) && f.key.includes('::'))
    })
    // Filter on the name alone. `getJobSchedulers()` never sets `id`: it builds every entry from the
    // `repeat:<key>` hash, which holds no id, and ioredis returns `{}` rather than null for a missing
    // hash, so BullMQ's colon-key fallback that would set one is never reached. Requiring an `id` here
    // matched nothing at all, which is what let `pieces-sync` survive every boot (#638).
    await Promise.all(staleSchedulers.map(job => systemJobsQueue.removeJobScheduler(job.key)))

    // Runs after the schedulers are gone: BullMQ refuses to remove a scheduler's current delayed
    // instance while the scheduler still exists. Only states a job can still be picked up from;
    // a failed or completed one never runs again and ages out on its own.
    const oneTimeJobs = await systemJobsQueue.getJobs(['delayed', 'waiting', 'prioritized'])
    const deprecatedOneTimeJobs = oneTimeJobs.filter(f => !isNil(f) && !isNil(f.id) && !isNil(f.name) && isDeprecatedJobName(f.name))
    await Promise.all(
        deprecatedOneTimeJobs.map(job => {
            assertNotNullOrUndefined(job.id, 'Job id is required')
            return job.remove()
        }),
    )
}

// A repeatable stored by an older BullMQ is a bare `name:jobId:endDate:tz:pattern` member of the
// scheduler set with no hash beside it, and `getJobSchedulers()` returns it with no name; the key is
// the only place the name survives.
function getSchedulerJobName(scheduler: JobSchedulerJson): string {
    return scheduler.name ?? scheduler.key.split(':')[0]
}

function isDeprecatedJobName(name: string): boolean {
    return DEPRECATED_SYSTEM_JOB_NAMES.includes(name)
}

const configureJobOptions = ({ schedule, jobId, customConfig }: { schedule: JobSchedule, jobId: string, customConfig?: JobsOptions }): JobsOptions => {
    const config: JobsOptions = customConfig ?? {}

    switch (schedule.type) {
        case 'one-time': {
            const now = apDayjs()
            config.delay = schedule.date.diff(now, 'milliseconds')
            break
        }
        case 'repeated': {
            config.repeat = {
                pattern: schedule.cron,
                tz: 'UTC',
            }
            break
        }
    }

    return {
        ...config,
        jobId,
    }
}

const getJobByNameAndJobId = async (name: string, jobId: string): Promise<Job | undefined> => {
    const job = await systemJobsQueue.getJob(jobId)
    if (!isNil(job) && job.name === name) {
        return job
    }
    return undefined
}

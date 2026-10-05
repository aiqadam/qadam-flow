import { apDayjs, apDayjsDuration } from '@aiqadam/server-utils'
import { assertNotNullOrUndefined, isNil, tryCatch } from '@aiqadam/shared'
import { Job, JobSchedulerJson, JobsOptions, Queue, Worker } from 'bullmq'
import { FastifyBaseLogger } from 'fastify'
import { redisConnections } from '../../database/redis-connections'
import { exceptionHandler } from '../exception-handler'
import { deprecatedSystemJobs, JobSchedule, SystemJobData, SystemJobName, SystemJobSchedule } from './common'
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
                if (deprecatedSystemJobs.isDeprecated(job.name)) {
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

        if (schedule.type === 'repeated') {
            // Keyed by the scheduler id, so a changed cron replaces the schedule in place instead of
            // adding a second repeatable beside the first one (#666). `queue.add(..., { repeat })`
            // produced an md5-keyed repeatable that `getJob(jobId)` could never find.
            // BullMQ types the scheduler id with the queue's `NameType`, but a scheduler id (`job.jobId`)
            // is a plain string; this local widened view avoids widening the queue itself and losing name
            // checking at every other call site.
            const schedulerQueue: Queue<SystemJobData, unknown, string> = systemJobsQueue
            await schedulerQueue.upsertJobScheduler(job.jobId, { pattern: schedule.cron, tz: 'UTC' }, {
                name: job.name,
                data: job.data,
                opts: customConfig,
            })
            return
        }

        const existingJob = await getJobByNameAndJobId(job.name, job.jobId)
        if (!isNil(existingJob) && await existingJob.isFailed()) {
            log.info({ jobName: job.name }, '[systemJob#upsertJob] Retrying failed job')
            await existingJob.retry()
            return
        }
        if (isNil(existingJob)) {
            log.info({ jobName: job.name }, '[systemJob#upsertJob] Adding job to queue')
            const jobOptions = configureJobOptions({ schedule, jobId: job.jobId, customConfig })
            await systemJobsQueue.add(job.name, job.data, jobOptions)
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
        if (deprecatedSystemJobs.isDeprecated(name)) {
            return true
        }
        // A repeatable created through `queue.add(name, data, { repeat, jobId })` is keyed by
        // `md5("name:jobId::tz:pattern")` and its hash has no `ic` field, so `getJobSchedulers()` returns
        // it without an `iterationCount`. A Job Schedulers API entry is keyed by its scheduler id and
        // `addJobScheduler` writes `ic` at creation (bullmq 5.61), so it always carries one. Sweep the
        // legacy repeatables for current names too, or replacing a cron leaves the old one firing beside
        // the new schedule (#666). `::` still covers the even older colon-format members, which have no
        // hash at all. The md5 key shape is required alongside the missing marker so a future BullMQ
        // change to `ic` cannot make this sweep mistake a live scheduler for a legacy repeatable.
        return knownJobNames.includes(name) && (f.key.includes('::') || (/^[0-9a-f]{32}$/.test(f.key) && isNil(f.iterationCount)))
    })
    // Filter on the name alone. `getJobSchedulers()` never sets `id`: it builds every entry from the
    // `repeat:<key>` hash, which holds no id, and ioredis returns `{}` rather than null for a missing
    // hash, so BullMQ's colon-key fallback that would set one is never reached. Requiring an `id` here
    // matched nothing at all, which is what let `pieces-sync` survive every boot (#638).
    await Promise.all(staleSchedulers.map(job => systemJobsQueue.removeJobScheduler(job.key)))

    // Runs after the schedulers are gone: BullMQ refuses to remove a scheduler's current delayed
    // instance while the scheduler still exists. Only states a job can still be picked up from;
    // a failed or completed one never runs again and ages out on its own.
    // A bare legacy key's instance has an id `removeJobScheduler` does not derive, and when the worker
    // picks it up it schedules the next one regardless, so for a current job name it would keep firing
    // beside the re-upserted schedule. Match those by the removed key, whatever their name.
    const removedSchedulerKeys = new Set(staleSchedulers.map(job => job.key))
    const oneTimeJobs = await systemJobsQueue.getJobs(['delayed', 'waiting', 'prioritized'])
    const staleJobs = oneTimeJobs.filter(f => !isNil(f) && !isNil(f.id) && !isNil(f.name) && (
        deprecatedSystemJobs.isDeprecated(f.name) || (!isNil(f.repeatJobKey) && removedSchedulerKeys.has(f.repeatJobKey))
    ))
    await Promise.all(
        staleJobs.map(job => {
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

const configureJobOptions = ({ schedule, jobId, customConfig }: { schedule: Extract<JobSchedule, { type: 'one-time' }>, jobId: string, customConfig?: JobsOptions }): JobsOptions => {
    return {
        ...customConfig,
        delay: schedule.date.diff(apDayjs(), 'milliseconds'),
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

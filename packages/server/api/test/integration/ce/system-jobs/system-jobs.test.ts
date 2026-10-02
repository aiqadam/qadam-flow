import { apDayjs } from '@aiqadam/server-utils'
import { Queue, QueueEvents } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { SystemJobData, SystemJobName } from '../../../../src/app/helper/system-jobs/common'
import { systemJobsQueue, systemJobsSchedule } from '../../../../src/app/helper/system-jobs/system-job'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

const TEST_PREFIX = 'test-'
const DEPRECATED_JOB_NAME = 'pieces-sync'

// BullMQ types `upsertJobScheduler`'s scheduler id as the queue's job-*name* type, so the
// strongly-named `systemJobsQueue` cannot express the legacy `<name>::<repeat-key>` ids these
// tests have to plant, nor the job names `SystemJobName` no longer has (`pieces-sync`, an unknown
// name) that the cleanup and worker tests add and look up. Both are plain strings at runtime; this
// widened view says so.
const legacySchedulerQueue = (): Queue<SystemJobData, unknown, string> => systemJobsQueue

let app: FastifyInstance
let schedule: ReturnType<typeof systemJobsSchedule>
let queueEvents: QueueEvents

beforeAll(async () => {
    app = await setupTestEnvironment()
    schedule = systemJobsSchedule(app.log)
    await schedule.init()
    queueEvents = new QueueEvents(systemJobsQueue.name, { connection: await redisConnections.create() })
    await queueEvents.waitUntilReady()
})

afterAll(async () => {
    await queueEvents.close()
    await schedule.close()
    await teardownTestEnvironment()
})

afterEach(async () => {
    const jobs = await systemJobsQueue.getJobs()
    for (const job of jobs) {
        if (job.id?.startsWith(TEST_PREFIX)) {
            await job.remove().catch(() => { /* already removed */ })
        }
    }
    const schedulers = await systemJobsQueue.getJobSchedulers()
    for (const s of schedulers) {
        const key = s.id ?? s.key
        if (key.startsWith(TEST_PREFIX) || key.includes('::') || key === 'qadams-analytics' || s.name === DEPRECATED_JOB_NAME) {
            await systemJobsQueue.removeJobScheduler(key).catch(() => { /* already removed */ })
        }
    }
})

describe('System Jobs', () => {
    it('should create a one-time job retrievable by jobId', async () => {
        const jobId = 'test-one-time-job'

        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(1, 'hour'),
            },
        })

        const retrieved = await schedule.getJob(jobId)
        expect(retrieved).toBeDefined()
        expect(retrieved!.name).toBe(SystemJobName.FILE_CLEANUP_TRIGGER)
    })

    it('should not duplicate when upserting with same jobId', async () => {
        const jobId = 'test-no-dup-job'

        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(1, 'hour'),
            },
        })

        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(2, 'hours'),
            },
        })

        const allJobs = await systemJobsQueue.getJobs()
        const matching = allJobs.filter(j => j.id === jobId)
        expect(matching).toHaveLength(1)
    })

    it('should create a repeated job scheduler', async () => {
        const jobId = 'test-repeated-job'

        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId,
            },
            schedule: {
                type: 'repeated',
                cron: '0 0 * * *',
            },
        })

        const schedulers = await systemJobsQueue.getJobSchedulers()
        const matching = schedulers.filter(s => s.name === SystemJobName.FILE_CLEANUP_TRIGGER)
        expect(matching.length).toBeGreaterThanOrEqual(1)
    })

    it('should return undefined for non-existent jobId', async () => {
        const result = await schedule.getJob('does-not-exist')
        expect(result).toBeUndefined()
    })

    it('should remove legacy schedulers with :: in key on init', async () => {
        // Simulate a legacy scheduler by creating one with a key containing '::'
        // This mimics what older BullMQ versions produced when no jobId was set.
        const legacyKey = `${SystemJobName.FILE_CLEANUP_TRIGGER}::0:UTC:0 3 * * *`
        await legacySchedulerQueue().upsertJobScheduler(legacyKey, {
            pattern: '0 3 * * *',
            tz: 'UTC',
        }, {
            name: SystemJobName.FILE_CLEANUP_TRIGGER,
            data: {} as never,
        })

        const before = await systemJobsQueue.getJobSchedulers()
        const legacyBefore = before.filter(
            s => s.name === SystemJobName.FILE_CLEANUP_TRIGGER && s.key.includes('::'),
        )
        expect(legacyBefore.length).toBeGreaterThanOrEqual(1)

        // Re-init triggers removeDeprecatedJobs which should clean up legacy schedulers
        await schedule.init()

        const after = await systemJobsQueue.getJobSchedulers()
        const legacyAfter = after.filter(
            s => s.name === SystemJobName.FILE_CLEANUP_TRIGGER && s.key.includes('::'),
        )
        expect(legacyAfter).toHaveLength(0)
    })

    it('should keep new-format schedulers while removing legacy ones', async () => {
        // Create a legacy scheduler (key contains ::)
        const legacyKey = `${SystemJobName.PIECES_ANALYTICS}::0:UTC:0 12 * * *`
        await legacySchedulerQueue().upsertJobScheduler(legacyKey, {
            pattern: '0 12 * * *',
            tz: 'UTC',
        }, {
            name: SystemJobName.PIECES_ANALYTICS,
            data: {} as never,
        })

        // Create a new-format scheduler (key is just the jobId, no ::)
        await schedule.upsertJob({
            job: {
                name: SystemJobName.PIECES_ANALYTICS,
                data: {},
                jobId: 'qadams-analytics',
            },
            schedule: {
                type: 'repeated',
                cron: '0 12 * * *',
            },
        })

        const before = await systemJobsQueue.getJobSchedulers()
        const analyticsBefore = before.filter(s => s.name === SystemJobName.PIECES_ANALYTICS)
        expect(analyticsBefore.length).toBeGreaterThanOrEqual(2)

        await schedule.init()

        const after = await systemJobsQueue.getJobSchedulers()
        const legacyAfter = after.filter(
            s => s.name === SystemJobName.PIECES_ANALYTICS && s.key.includes('::'),
        )
        const newAfter = after.filter(
            s => s.name === SystemJobName.PIECES_ANALYTICS && !s.key.includes('::'),
        )
        expect(legacyAfter).toHaveLength(0)
        expect(newAfter.length).toBeGreaterThanOrEqual(1)
    })

    it('should not match job when jobId exists but name differs', async () => {
        const jobId = 'test-name-guard'

        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(1, 'hour'),
            },
        })

        // Raw BullMQ lookup finds the job
        const raw = await systemJobsQueue.getJob(jobId)
        expect(raw).toBeDefined()
        expect(raw!.name).toBe(SystemJobName.FILE_CLEANUP_TRIGGER)

        // Upserting with same jobId but different name treats it as non-existent
        // (name guard rejects the match), so upsert attempts to add again.
        // BullMQ deduplicates by jobId, so the original job persists unchanged.
        await schedule.upsertJob({
            job: {
                name: SystemJobName.RUN_TELEMETRY,
                data: {},
                jobId,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(2, 'hours'),
            },
        })

        const after = await systemJobsQueue.getJob(jobId)
        expect(after).toBeDefined()
        expect(after!.name).toBe(SystemJobName.FILE_CLEANUP_TRIGGER)
    })

    // #638: pre-#136 builds scheduled `pieces-sync` through `upsertJob`, i.e.
    // `queue.add(name, data, { repeat, jobId })`, with a random minute in the cron. `upsertJob` looks the job
    // up by `jobId`, which never matches a repeat instance's `repeat:<key>:<millis>` id, so every boot with a
    // different minute added one more repeatable. Plant them exactly that way.
    it('should remove deprecated repeatables created through queue.add with a repeat option on init', async () => {
        const legacyPatterns = ['0 */1 * * *', '1 */1 * * *', '2 */1 * * *']
        for (const pattern of legacyPatterns) {
            await legacySchedulerQueue().add(DEPRECATED_JOB_NAME, {}, {
                repeat: { pattern, tz: 'UTC' },
                jobId: DEPRECATED_JOB_NAME,
            })
        }
        const keptPattern = '17 4 * * *'
        await schedule.upsertJob({
            job: {
                name: SystemJobName.FILE_CLEANUP_TRIGGER,
                data: {},
                jobId: 'test-kept-repeated-job',
            },
            schedule: {
                type: 'repeated',
                cron: keptPattern,
            },
        })

        const before = await systemJobsQueue.getJobSchedulers()
        const deprecatedBefore = before.filter(s => s.name === DEPRECATED_JOB_NAME)
        expect(deprecatedBefore).toHaveLength(legacyPatterns.length)
        const delayedBefore = await legacySchedulerQueue().getJobs(['delayed'])
        expect(delayedBefore.filter(j => j.name === DEPRECATED_JOB_NAME)).toHaveLength(legacyPatterns.length)

        await schedule.init()

        const after = await systemJobsQueue.getJobSchedulers()
        expect(after.filter(s => s.name === DEPRECATED_JOB_NAME)).toHaveLength(0)
        const client = await systemJobsQueue.client
        for (const scheduler of deprecatedBefore) {
            expect(await client.exists(`${systemJobsQueue.keys.repeat}:${scheduler.key}`)).toBe(0)
        }
        const jobsAfter = await legacySchedulerQueue().getJobs()
        expect(jobsAfter.filter(j => j?.name === DEPRECATED_JOB_NAME)).toHaveLength(0)

        const kept = after.filter(s => s.name === SystemJobName.FILE_CLEANUP_TRIGGER && s.pattern === keptPattern)
        expect(kept).toHaveLength(1)
        await systemJobsQueue.removeJobScheduler(kept[0].key)
    })

    // Older BullMQ releases stored a repeatable as a bare `name:jobId:endDate:tz:pattern` member with no
    // hash beside it, which `getJobSchedulers()` returns with no name.
    it('should remove a deprecated colon-format legacy repeatable on init', async () => {
        const legacyKey = `${DEPRECATED_JOB_NAME}:${DEPRECATED_JOB_NAME}:::3 */1 * * *`
        const client = await systemJobsQueue.client
        await client.zadd(systemJobsQueue.keys.repeat, apDayjs().add(1, 'hour').valueOf(), legacyKey)

        const before = await systemJobsQueue.getJobSchedulers()
        expect(before.filter(s => s.key === legacyKey)).toHaveLength(1)

        await schedule.init()

        expect(await client.zscore(systemJobsQueue.keys.repeat, legacyKey)).toBeNull()
    })
})

describe('System job worker', () => {
    it('should acknowledge a job with a deprecated name instead of failing it', async () => {
        const job = await legacySchedulerQueue().add(DEPRECATED_JOB_NAME, {}, {
            jobId: 'test-deprecated-job',
            attempts: 1,
        })

        // BullMQ stores the processor's `undefined` return value as `null`.
        await expect(job.waitUntilFinished(queueEvents, 10_000)).resolves.toBeNull()
    })

    it('should still fail a job with an unknown name', async () => {
        const job = await legacySchedulerQueue().add('test-unknown-job', {}, {
            jobId: 'test-unknown-job',
            attempts: 1,
        })

        await expect(job.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow('No handler for job test-unknown-job')
    })
})

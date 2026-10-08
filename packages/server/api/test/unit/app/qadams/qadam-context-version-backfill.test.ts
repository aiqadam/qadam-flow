import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemJobName } from '../../../../src/app/helper/system-jobs/common'

const registerJobHandler = vi.fn()
const upsertJob = vi.fn()

vi.mock('../../../../src/app/helper/system-jobs/job-handlers', () => ({
    systemJobHandlers: { registerJobHandler: (...args: unknown[]) => registerJobHandler(...args) },
}))
vi.mock('../../../../src/app/helper/system-jobs/system-job', () => ({
    systemJobsSchedule: () => ({ upsertJob: (...args: unknown[]) => upsertJob(...args) }),
}))

// The backfill's WHERE clause and bounded runs are covered by integration tests, but the job that
// runs it was referenced by nothing: deleting the registration and the schedule left the whole
// suite green, and no row would ever be filled.
import { qadamContextVersionBackfill } from '../../../../src/app/qadams/qadam-context-version-backfill'

const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as unknown as FastifyBaseLogger

describe('qadamContextVersionBackfill schedule (#802)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // `schedule()` skips the repeated job under AP_ENVIRONMENT=test (the `.env.tests` default);
        // the production path is what this test pins.
        vi.stubEnv('AP_ENVIRONMENT', 'dev')
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('registers the handler and schedules the repeated job under its fixed id', async () => {
        await qadamContextVersionBackfill(mockLog).schedule()

        expect(registerJobHandler).toHaveBeenCalledWith(SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL, expect.any(Function))
        expect(upsertJob).toHaveBeenCalledTimes(1)
        expect(upsertJob).toHaveBeenCalledWith({
            job: {
                name: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
                data: {},
                jobId: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
            },
            schedule: {
                type: 'repeated',
                cron: '17 * * * *',
            },
        })
    })
})

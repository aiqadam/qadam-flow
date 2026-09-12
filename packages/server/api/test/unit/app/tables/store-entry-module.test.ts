import { SystemJobName } from '../../../../src/app/helper/system-jobs/common'

const registerJobHandler = vi.fn()
const upsertJob = vi.fn()
const deleteExpired = vi.fn()

vi.mock('../../../../src/app/helper/system-jobs/job-handlers', () => ({
    systemJobHandlers: { registerJobHandler: (...args: unknown[]) => registerJobHandler(...args) },
}))
vi.mock('../../../../src/app/helper/system-jobs/system-job', () => ({
    systemJobsSchedule: () => ({ upsertJob: (...args: unknown[]) => upsertJob(...args) }),
}))
vi.mock('../../../../src/app/store-entry/store-entry.service', () => ({
    storeEntryService: { deleteExpired: (...args: unknown[]) => deleteExpired(...args) },
}))

// The sweep's WHERE clause is covered by an integration test, but the job that runs it
// was referenced by nothing: deleting the registration and the schedule left the whole
// suite green, and expired entries would simply accumulate forever.
import { storeEntryModule } from '../../../../src/app/store-entry/store-entry.module'

function fakeApp() {
    return {
        addHook: vi.fn(),
        register: vi.fn(),
        log: { info: vi.fn(), error: vi.fn() },
    }
}

describe('storeEntryModule', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        deleteExpired.mockResolvedValue(0)
    })

    it('registers the cleanup handler and schedules it', async () => {
        const app = fakeApp()

        await storeEntryModule(app as never, {} as never)

        expect(registerJobHandler).toHaveBeenCalledWith(SystemJobName.STORE_ENTRY_CLEANUP, expect.any(Function))
        const [[{ job, schedule }]] = upsertJob.mock.calls
        expect(job).toMatchObject({ name: SystemJobName.STORE_ENTRY_CLEANUP, jobId: SystemJobName.STORE_ENTRY_CLEANUP })
        expect(schedule.type).toBe('repeated')
        expect(schedule.cron).toMatch(/^\d+ \*\/1 \* \* \*$/)
    })

    // A backlog must not hold a lock over the whole table, so the handler deletes in
    // bounded batches and keeps going while a batch comes back full.
    it('keeps sweeping while a batch comes back full, then stops', async () => {
        const app = fakeApp()
        await storeEntryModule(app as never, {} as never)
        const handler = registerJobHandler.mock.calls[0][1] as () => Promise<void>

        deleteExpired.mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValueOnce(7)
        await handler()

        expect(deleteExpired).toHaveBeenCalledTimes(3)
        expect(deleteExpired).toHaveBeenLastCalledWith({ limit: 1000 })
    })

    it('stops after one pass when nothing is expired', async () => {
        const app = fakeApp()
        await storeEntryModule(app as never, {} as never)
        const handler = registerJobHandler.mock.calls[0][1] as () => Promise<void>

        await handler()

        expect(deleteExpired).toHaveBeenCalledTimes(1)
    })
})

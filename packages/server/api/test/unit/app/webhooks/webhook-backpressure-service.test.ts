import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFind, mockGetJobCounts, mockGet } = vi.hoisted(() => ({
    mockFind: vi.fn(),
    mockGetJobCounts: vi.fn(),
    mockGet: vi.fn(),
}))

vi.mock('../../../../src/app/workers/machine/machine-cache', () => ({
    workerMachineCache: (): { find: typeof mockFind } => ({
        find: mockFind,
    }),
}))

vi.mock('../../../../src/app/workers/job-queue/job-queue', () => ({
    jobQueue: (): { getSharedQueue: () => { getJobCounts: typeof mockGetJobCounts } } => ({
        getSharedQueue: () => ({
            getJobCounts: mockGetJobCounts,
        }),
    }),
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getBoolean: mockGet.mockImplementation(() => true),
        getNumberOrThrow: (): number => 5,
    },
}))

import { webhookBackpressureService } from '../../../../src/app/webhooks/webhook-backpressure-service'

function makeLog(): any {
    return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeWorker(concurrency: string | undefined): any {
    return {
        information: {
            workerProps: { WORKER_CONCURRENCY: concurrency },
        },
    }
}

describe('webhookBackpressureService', () => {
    beforeEach(() => {
        mockFind.mockReset()
        mockGetJobCounts.mockReset()
        mockGet.mockReset().mockReturnValue(true)
    })

    it('allows the request through when disabled via config', async () => {
        mockGet.mockReturnValue(false)
        mockFind.mockResolvedValue([])

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        expect(result.ok).toBe(true)
        expect(mockFind).not.toHaveBeenCalled()
    })

    it('allows the request through when no worker has ever registered (unknown, not zero, capacity)', async () => {
        mockFind.mockResolvedValue([])

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        expect(result.ok).toBe(true)
        expect(mockGetJobCounts).not.toHaveBeenCalled()
    })

    it('allows the measured baseline through: 40 offered against 25 slots settles at ~15 waiting', async () => {
        mockFind.mockResolvedValue([makeWorker('25')])
        mockGetJobCounts.mockResolvedValue({ waiting: 10, active: 25, prioritized: 5 })

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        expect(result.ok).toBe(true)
    })

    it('refuses once every slot is busy and a full extra round is already waiting', async () => {
        mockFind.mockResolvedValue([makeWorker('25')])
        mockGetJobCounts.mockResolvedValue({ waiting: 20, active: 25, prioritized: 5 })

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        expect(result).toEqual({ ok: false, retryAfterSeconds: 5 })
    })

    it('allows through when there is a backlog but slots are not all busy', async () => {
        mockFind.mockResolvedValue([makeWorker('25')])
        mockGetJobCounts.mockResolvedValue({ waiting: 30, active: 10, prioritized: 0 })

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        expect(result.ok).toBe(true)
    })

    it('sums concurrency across every online worker, defaulting an unparsable value to 1 slot', async () => {
        mockFind.mockResolvedValue([makeWorker('10'), makeWorker(undefined), makeWorker('not-a-number')])
        mockGetJobCounts.mockResolvedValue({ waiting: 11, active: 12, prioritized: 0 })

        const result = await webhookBackpressureService(makeLog()).checkCapacity()

        // slots = 10 + 1 + 1 = 12; active(12) >= 12 and waiting(11) < 12 -> still allowed
        expect(result.ok).toBe(true)
    })
})

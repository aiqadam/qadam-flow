import { MachineInformation, WorkerMachineStatus, WorkerMachineType } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerMachine, workerMachineCache } from '../../../../../src/app/workers/machine/machine-cache'
import { machineService } from '../../../../../src/app/workers/machine/machine-service'

let inMemoryStore: Map<string, WorkerMachine>

vi.mock('../../../../../src/app/workers/machine/machine-cache', () => ({
    workerMachineCache: () => ({
        async find(): Promise<WorkerMachine[]> {
            return Array.from(inMemoryStore.values())
        },
        async delete(ids: string[]): Promise<void> {
            for (const id of ids) {
                inMemoryStore.delete(id)
            }
        },
        async upsert(worker: { id: string } & Partial<Omit<WorkerMachine, 'id'>>): Promise<void> {
            const now = new Date().toISOString()
            const existing = inMemoryStore.get(worker.id)
            if (existing) {
                inMemoryStore.set(worker.id, { ...existing, ...worker, updated: now })
            }
            else {
                inMemoryStore.set(worker.id, { ...worker, updated: now, created: now } as WorkerMachine)
            }
        },
    }),
}))

const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
} as never

function fakeMachineInfo(workerId: string): MachineInformation {
    return {
        workerId,
        cpuUsagePercentage: 0,
        ramUsagePercentage: 0,
        totalAvailableRamInBytes: 0,
        totalCpuCores: 1,
        ip: '127.0.0.1',
        diskInfo: { total: 100, free: 50, used: 50, percentage: 50 },
        workerProps: {},
        sandboxes: [],
    }
}

describe('machineService.list — platform filtering', () => {
    beforeEach(() => {
        inMemoryStore = new Map()
    })

    it('should return shared workers for any platform', async () => {
        await workerMachineCache().upsert({
            id: 'shared-1',
            information: fakeMachineInfo('shared-1'),
            type: 'SHARED',
        })

        const result = await machineService(mockLogger).list('platform-A')

        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('shared-1')
        expect(result[0].type).toBe(WorkerMachineType.SHARED)
        expect(result[0].status).toBe(WorkerMachineStatus.ONLINE)
    })

    it('should not return other platforms dedicated workers', async () => {
        await workerMachineCache().upsert({
            id: 'dedicated-other',
            information: fakeMachineInfo('dedicated-other'),
            type: 'DEDICATED',
            workerGroupId: 'group-other',
        })

        const result = await machineService(mockLogger).list('platform-mine')
        expect(result).toHaveLength(0)
    })

    it('should return shared workers when platform has no worker group', async () => {
        await workerMachineCache().upsert({
            id: 'shared-1',
            information: fakeMachineInfo('shared-1'),
            type: 'SHARED',
        })

        await workerMachineCache().upsert({
            id: 'dedicated-other',
            information: fakeMachineInfo('dedicated-other'),
            type: 'DEDICATED',
            workerGroupId: 'group-Y',
        })

        const result = await machineService(mockLogger).list('platform-no-group')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('shared-1')
        expect(result[0].type).toBe(WorkerMachineType.SHARED)
    })

    it('should include legacy workers with no type as shared', async () => {
        await workerMachineCache().upsert({
            id: 'legacy-worker',
            information: fakeMachineInfo('legacy-worker'),
        })

        const result = await machineService(mockLogger).list('any-platform')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('legacy-worker')
        expect(result[0].type).toBe(WorkerMachineType.SHARED)
    })

    it('never returns a DEDICATED worker, to any platform — the tripwire for #202', async () => {
        await workerMachineCache().upsert({
            id: 'dedicated-1',
            information: fakeMachineInfo('dedicated-1'),
            type: 'DEDICATED',
            workerGroupId: 'group-1',
        })

        const resultForPlatformA = await machineService(mockLogger).list('platform-A')
        const resultForPlatformB = await machineService(mockLogger).list('platform-B')

        // Check by id, not by the returned `type` — `list()` normalises every returned
        // worker's `type` to SHARED in its own `.map()`, so asserting on that field
        // would pass even if the DEDICATED worker itself leaked through.
        for (const result of [resultForPlatformA, resultForPlatformB]) {
            expect(result.map(worker => worker.id)).not.toContain('dedicated-1')
        }
    })
})

import { MachineInformation } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const upsert = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../../../src/app/workers/machine/machine-cache', () => ({
    workerMachineCache: () => ({
        findOne: vi.fn().mockResolvedValue(null),
        upsert,
    }),
}))

vi.mock('../../../../../src/app/helper/system/system', () => ({
    system: {
        getOrThrow: vi.fn().mockReturnValue('test-value'),
        getNumberOrThrow: vi.fn().mockReturnValue(60),
        get: vi.fn().mockReturnValue(undefined),
    },
}))

vi.mock('../../../../../src/app/helper/domain-helper', () => ({
    domainHelper: { getPublicUrl: vi.fn().mockResolvedValue('https://example.com') },
}))

import { machineService } from '../../../../../src/app/workers/machine/machine-service'

const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

const machineInfo: MachineInformation = {
    workerId: 'worker-1',
    cpuUsagePercentage: 1,
    ramUsagePercentage: 2,
    totalAvailableRamInBytes: 8,
    totalCpuCores: 1,
    ip: '10.0.0.1',
    workerProps: {},
    sandboxes: [],
    diskInfo: { total: 10, free: 5, used: 5, percentage: 50 },
}

describe('machineService.onConnection worker group', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('registers a worker with no group as SHARED — what a token minted before the claim existed gets', async () => {
        await machineService(log).onConnection(machineInfo)

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-1', type: 'SHARED', workerGroupId: undefined }))
    })

    it('registers a worker whose token carries a group as DEDICATED in that group', async () => {
        await machineService(log).onConnection(machineInfo, 'group-a')

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ type: 'DEDICATED', workerGroupId: 'group-a' }))
    })
})

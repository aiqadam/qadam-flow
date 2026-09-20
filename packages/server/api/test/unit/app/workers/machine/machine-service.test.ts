import { ExecutionMode, MachineInformation } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../src/app/workers/machine/machine-cache', () => ({
    workerMachineCache: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
    })),
}))

vi.mock('../../../../../src/app/helper/system/system', () => ({
    system: {
        getOrThrow: vi.fn().mockReturnValue('test-value'),
        getNumberOrThrow: vi.fn().mockReturnValue(60),
        get: vi.fn().mockReturnValue(undefined),
    },
}))

vi.mock('../../../../../src/app/helper/domain-helper', () => ({
    domainHelper: {
        getPublicUrl: vi.fn().mockResolvedValue('https://example.com'),
    },
}))

import { system } from '../../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../../src/app/helper/system/system-props'

const mockLog = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as any

const mockHealthcheck: MachineInformation = {
    workerId: 'test-worker-1',
    cpuUsagePercentage: 10,
    ramUsagePercentage: 20,
    totalAvailableRamInBytes: 1024,
    totalCpuCores: 1,
    ip: '127.0.0.1',
    workerProps: {},
    sandboxes: [],
    diskInfo: {
        total: 1000,
        free: 500,
        used: 500,
        percentage: 50,
    },
}

describe('machineService — execution mode', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('should return system default execution mode for shared workers', async () => {
        vi.mocked(system.getOrThrow).mockReturnValue(ExecutionMode.SANDBOX_PROCESS as any)

        const { machineService: freshMachineService } = await import('../../../../../src/app/workers/machine/machine-service')
        const result = await freshMachineService(mockLog).onConnection(mockHealthcheck)

        expect(result.EXECUTION_MODE).toBe(ExecutionMode.SANDBOX_PROCESS)
    })

    it('should return system default execution mode for dedicated workers', async () => {
        vi.mocked(system.getOrThrow).mockReturnValue(ExecutionMode.SANDBOX_CODE_AND_PROCESS as any)

        const { machineService: freshMachineService } = await import('../../../../../src/app/workers/machine/machine-service')
        const result = await freshMachineService(mockLog).onConnection(mockHealthcheck, 'my-worker-group')

        expect(result.EXECUTION_MODE).toBe(ExecutionMode.SANDBOX_CODE_AND_PROCESS)
    })
})

// Covers the two links the flag's off-by-default safety argument actually rests on that
// `needsInstalling()`'s and `shadowKey()`'s own tests cannot reach: the default value itself, and
// this function's translation of it onto the wire the worker reads. Neither mutating
// `systemPropDefaultValues[OFFICIAL_QADAMS_INSTALL_ENABLED]` to `'true'` nor flipping this file's
// `=== 'true'` to `!== 'true'` should leave every other test in the repo green.
describe('machineService — OFFICIAL_QADAMS_INSTALL_ENABLED wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('defaults to false on the wire when system.get returns nothing for it', async () => {
        vi.mocked(system.get).mockReturnValue(undefined)

        const { machineService: freshMachineService } = await import('../../../../../src/app/workers/machine/machine-service')
        const result = await freshMachineService(mockLog).onConnection(mockHealthcheck)

        expect(result.OFFICIAL_QADAMS_INSTALL_ENABLED).toBe(false)
    })

    it('turns true on the wire only when system.get resolves this prop to the string "true"', async () => {
        vi.mocked(system.get).mockImplementation((prop: string) =>
            prop === AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED ? 'true' : undefined,
        )

        const { machineService: freshMachineService } = await import('../../../../../src/app/workers/machine/machine-service')
        const result = await freshMachineService(mockLog).onConnection(mockHealthcheck)

        expect(result.OFFICIAL_QADAMS_INSTALL_ENABLED).toBe(true)
    })
})

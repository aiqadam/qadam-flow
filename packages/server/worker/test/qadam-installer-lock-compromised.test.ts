import { randomUUID } from 'node:crypto'
import { access, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackageType, QadamType } from '@aiqadam/shared'
import type { QadamPackage } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamInstaller } from '../src/lib/cache/qadams/qadam-installer'

// proper-lockfile reports a compromise only from its refresh timer, minutes into a held lock, so
// the lock is stubbed and the test decides when the installer loses it.
const lockStub = vi.hoisted(() => ({
    compromised: false,
}))

const mockInstall = vi.fn()
let testWorkspace = ''

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        fileLock: {
            ...actual.fileLock,
            runExclusive: async <T>({ fn }: { fn: (lock: { isCompromised: () => boolean }) => Promise<T> }): Promise<T> =>
                fn({ isCompromised: () => lockStub.compromised }),
        },
    }
})

vi.mock('../src/lib/cache/code/bun-runner', () => ({
    bunRunner: () => ({
        install: mockInstall,
    }),
}))

vi.mock('../src/lib/cache/qadams/qadam-integrity', () => ({
    qadamIntegrity: () => ({
        verifyOfficialQadams: vi.fn(),
        refusedKeysIn: vi.fn(() => new Set()),
    }),
}))

vi.mock('../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: () => ({
            EXECUTION_MODE: 'UNSANDBOXED',
            DEV_QADAMS: [],
            OFFICIAL_QADAMS_INSTALL_ENABLED: false,
        }),
    },
}))

vi.mock('../src/lib/cache/cache-paths', () => ({
    getGlobalCacheCommonPath: () => testWorkspace,
    getGlobalCachePathLatestVersion: () => testWorkspace,
}))

beforeEach(async () => {
    testWorkspace = join(tmpdir(), `qadam-installer-compromised-test-${randomUUID()}`)
    await mkdir(testWorkspace, { recursive: true })
    lockStub.compromised = false
    mockInstall.mockReset()
})

afterEach(async () => {
    await rm(testWorkspace, { recursive: true, force: true })
})

describe('qadamInstaller when the workspace lock is compromised', () => {
    it('does not run bun install once the lock is lost', async () => {
        lockStub.compromised = true

        await expect(install([makeQadam('@aiqadam/qadam-a')])).rejects.toThrow('Lost the lock')
        expect(mockInstall).not.toHaveBeenCalled()
    })

    it('does not mark an install ready when the lock was lost while bun ran', async () => {
        const qadam = makeQadam('@aiqadam/qadam-a')
        mockInstall.mockImplementation(async () => {
            lockStub.compromised = true
            return { output: '' }
        })

        await expect(install([qadam])).rejects.toThrow('Lost the lock')
        expect(await access(join(testWorkspace, 'qadams', `${qadam.qadamName}-${qadam.qadamVersion}`, 'ready')).then(() => true, () => false)).toBe(false)
    })

    it('does not start the one-by-one retry once the lock is lost', async () => {
        mockInstall.mockImplementationOnce(async () => {
            lockStub.compromised = true
            throw new Error('batch install failed')
        })

        await expect(install([makeQadam('@aiqadam/qadam-a'), makeQadam('@aiqadam/qadam-b')])).rejects.toThrow('Lost the lock')
        expect(mockInstall).toHaveBeenCalledTimes(1)
    })

    it('stops the one-by-one retry at the next qadam once the lock is lost mid-retry', async () => {
        mockInstall
            .mockImplementationOnce(async () => {
                throw new Error('batch install failed')
            })
            .mockImplementationOnce(async () => {
                lockStub.compromised = true
                return { output: '' }
            })

        await expect(install([makeQadam('@aiqadam/qadam-a'), makeQadam('@aiqadam/qadam-b')])).rejects.toThrow('Lost the lock')
        expect(mockInstall).toHaveBeenCalledTimes(2)
    })
})

async function install(pieces: QadamPackage[]): Promise<void> {
    // REGISTRY qadams never ask the API client for an archive.
    const apiClient = {} as never
    await qadamInstaller(pino({ level: 'silent' }), apiClient).install({ pieces, includeFilters: true })
}

function makeQadam(name: string): QadamPackage {
    return {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.CUSTOM,
        qadamName: name,
        qadamVersion: '1.0.0',
        platformId: 'platform_1',
    }
}

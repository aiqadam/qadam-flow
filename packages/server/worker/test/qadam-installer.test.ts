import { access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageType, QadamType } from '@aiqadam/shared'
import type { OfficialQadamPackage } from '@aiqadam/shared'
import type { Logger } from 'pino'

// Module-level variable updated per test so the vi.mock factory can reference it
let testWorkspace = ''

const mockInstall = vi.fn()

vi.mock('../src/lib/cache/code/bun-runner', () => ({
    bunRunner: () => ({
        install: mockInstall,
    }),
}))

vi.mock('../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: () => ({
            EXECUTION_MODE: 'UNSANDBOXED',
            DEV_QADAMS: [],
        }),
    },
}))

vi.mock('../src/lib/cache/cache-paths', () => ({
    getGlobalCacheCommonPath: () => testWorkspace,
    getGlobalCachePathLatestVersion: () => testWorkspace,
}))

// Import after mocks are registered
const { qadamInstaller } = await import('../src/lib/cache/qadams/qadam-installer')

function makeQadam(name: string, version = '1.0.0'): OfficialQadamPackage {
    return {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
        qadamName: name,
        qadamVersion: version,
    }
}

function qadamDirPath(qadam: OfficialQadamPackage): string {
    return join(testWorkspace, 'qadams', `${qadam.qadamName}-${qadam.qadamVersion}`)
}

function readyFilePath(qadam: OfficialQadamPackage): string {
    return join(qadamDirPath(qadam), 'ready')
}

async function pathExists(p: string): Promise<boolean> {
    return access(p).then(() => true, () => false)
}

const fakeLog = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger

// REGISTRY pieces don't call apiClient.getPieceArchive so an empty object suffices
const fakeApiClient = {} as never

beforeEach(async () => {
    testWorkspace = join(tmpdir(), `qadam-installer-test-${randomUUID()}`)
    await mkdir(testWorkspace, { recursive: true })
    vi.clearAllMocks()
})

afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(testWorkspace, { recursive: true, force: true })
})

describe('qadamInstaller', () => {
    it('batch install succeeds — all pieces marked ready', async () => {
        const qadam1 = makeQadam('@aiqadam/qadam-a')
        const qadam2 = makeQadam('@aiqadam/qadam-b')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockResolvedValueOnce({ output: '' })

        await installer.install({ pieces: [qadam1, qadam2], includeFilters: true })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(qadam1))).toBe(true)
        expect(await pathExists(readyFilePath(qadam2))).toBe(true)
    })

    it('batch fails with good and bad piece — good piece marked ready, bad piece rolled back', async () => {
        const good = makeQadam('@aiqadam/qadam-good')
        const bad = makeQadam('@aiqadam/qadam-bad')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // batch attempt
            .mockResolvedValueOnce({ output: '' })                           // good individual
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // bad individual

        const error = await installer.install({ pieces: [good, bad], includeFilters: false }).catch(e => e as Error)

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('@aiqadam/qadam-bad@1.0.0')
        expect(error.message).not.toContain('@aiqadam/qadam-good@1.0.0')
        expect(mockInstall).toHaveBeenCalledTimes(3)

        expect(await pathExists(readyFilePath(good))).toBe(true)
        expect(await pathExists(qadamDirPath(bad))).toBe(false)
    })

    it('batch fails with both pieces bad — both rolled back, error names both', async () => {
        const qadam1 = makeQadam('@aiqadam/qadam-x')
        const qadam2 = makeQadam('@aiqadam/qadam-y')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // batch
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // qadam-x individual
            .mockRejectedValueOnce(new Error('workspace:* resolve error'))  // qadam-y individual

        const error = await installer.install({ pieces: [qadam1, qadam2], includeFilters: false }).catch(e => e as Error)

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain('@aiqadam/qadam-x@1.0.0')
        expect(error.message).toContain('@aiqadam/qadam-y@1.0.0')
        expect(mockInstall).toHaveBeenCalledTimes(3)

        expect(await pathExists(qadamDirPath(qadam1))).toBe(false)
        expect(await pathExists(qadamDirPath(qadam2))).toBe(false)
    })

    it('single qadam fails — rolled back immediately, no individual retry', async () => {
        const qadam = makeQadam('@aiqadam/qadam-solo')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockRejectedValueOnce(new Error('install failure'))

        await expect(installer.install({ pieces: [qadam], includeFilters: true })).rejects.toThrow('install failure')

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(qadamDirPath(qadam))).toBe(false)
    })

    it('qadam already installed — bun install never called', async () => {
        const qadam = makeQadam('@aiqadam/qadam-cached')
        const qadamDir = qadamDirPath(qadam)

        await mkdir(join(qadamDir, 'node_modules'), { recursive: true })
        await writeFile(join(qadamDir, 'ready'), 'true')

        const installer = qadamInstaller(fakeLog, fakeApiClient)
        await installer.install({ pieces: [qadam], includeFilters: true })

        expect(mockInstall).not.toHaveBeenCalled()
    })

    it('individual fallback always passes --filter path regardless of includeFilters', async () => {
        const qadam1 = makeQadam('@aiqadam/qadam-filter-a')
        const qadam2 = makeQadam('@aiqadam/qadam-filter-b')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall
            .mockRejectedValueOnce(new Error('batch error'))
            .mockResolvedValueOnce({ output: '' })
            .mockResolvedValueOnce({ output: '' })

        // Use includeFilters: false so the batch call has no filters
        await installer.install({ pieces: [qadam1, qadam2], includeFilters: false })

        expect(mockInstall).toHaveBeenCalledTimes(3)

        // Batch call uses empty filtersPath because includeFilters is false
        expect(mockInstall.mock.calls[0]?.[0]).toMatchObject({ filtersPath: [] })

        // Individual calls must always include the --filter path (sequential order)
        expect(mockInstall.mock.calls[1]?.[0]).toMatchObject({
            filtersPath: [expect.stringContaining(`${qadam1.qadamName}-${qadam1.qadamVersion}`)],
        })
        expect(mockInstall.mock.calls[2]?.[0]).toMatchObject({
            filtersPath: [expect.stringContaining(`${qadam2.qadamName}-${qadam2.qadamVersion}`)],
        })
    })
})

import { access, glob, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageType, QadamType } from '@aiqadam/shared'
import type { OfficialQadamPackage, QadamPackage } from '@aiqadam/shared'
import type { Logger } from 'pino'
import { qadamInstaller } from '../src/lib/cache/qadams/qadam-installer'

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

// Custom by default: an official qadam ships in the image and is never installed, so it would
// exercise none of the install mechanics below.
function makeQadam(name: string, version = '1.0.0'): QadamPackage {
    return {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.CUSTOM,
        qadamName: name,
        qadamVersion: version,
        platformId: 'platform_1',
    }
}

function makeOfficialQadam(name: string, version = '1.0.0'): OfficialQadamPackage {
    return {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
        qadamName: name,
        qadamVersion: version,
    }
}

function qadamDirPath(qadam: QadamPackage): string {
    return join(testWorkspace, 'qadams', `${qadam.qadamName}-${qadam.qadamVersion}`)
}

function readyFilePath(qadam: QadamPackage): string {
    return join(qadamDirPath(qadam), 'ready')
}

async function pathExists(p: string): Promise<boolean> {
    return access(p).then(() => true, () => false)
}

function readWorkspaceGlobs(packageJson: unknown): string[] {
    if (typeof packageJson !== 'object' || packageJson === null || !('workspaces' in packageJson)) {
        return []
    }
    const { workspaces } = packageJson
    if (!Array.isArray(workspaces)) {
        return []
    }
    return workspaces.filter((pattern): pattern is string => typeof pattern === 'string')
}

// Stands in for the real `bun install`: it only links a package that the root package.json's
// `workspaces` globs actually match, which is the behaviour the glob regression turns on. A
// filtered run links only the requested workspaces, exactly like `bun install --filter`.
async function simulateBunInstall({ path: rootWorkspace, filtersPath }: { path: string, filtersPath: string[] }): Promise<{ output: string }> {
    const rootPackageJson: unknown = JSON.parse(await readFile(join(rootWorkspace, 'package.json'), 'utf8'))
    const requested = filtersPath.map((filterPath) => filterPath.replace(/^\.\//, ''))

    const matched: string[] = []
    for (const pattern of readWorkspaceGlobs(rootPackageJson)) {
        for await (const entry of glob(pattern, { cwd: rootWorkspace })) {
            matched.push(entry)
        }
    }

    for (const entry of matched) {
        const isRequested = requested.length === 0 || requested.includes(entry)
        if (!isRequested || !await pathExists(join(rootWorkspace, entry, 'package.json'))) {
            continue
        }
        await mkdir(join(rootWorkspace, entry, 'node_modules'), { recursive: true })
    }

    return { output: '' }
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
    mockInstall.mockReset()
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
        // Named one by one, so bun installs these qadams rather than every workspace sharing
        // the cache directory — an unfiltered install holds the cross-replica lock for the
        // whole cache.
        expect(mockInstall.mock.calls[0]?.[0]).toMatchObject({
            filtersPath: [
                expect.stringContaining(`${qadam1.qadamName}-${qadam1.qadamVersion}`),
                expect.stringContaining(`${qadam2.qadamName}-${qadam2.qadamVersion}`),
            ],
        })
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

        const error = await installer.install({ pieces: [good, bad], includeFilters: false }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(Error)
        if (!(error instanceof Error)) {
            throw error
        }
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

        const error = await installer.install({ pieces: [qadam1, qadam2], includeFilters: false }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(Error)
        if (!(error instanceof Error)) {
            throw error
        }
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

    // The registry these names would be resolved against does not carry them: official qadams are
    // compiled into the image and loaded from dist. Asking bun for one fails the job.
    it('never installs an official qadam', async () => {
        const official = makeOfficialQadam('@aiqadam/qadam-subflows', '0.4.14')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [official], includeFilters: true })

        expect(mockInstall).not.toHaveBeenCalled()
        expect(await pathExists(qadamDirPath(official))).toBe(false)
    })

    it('installs the custom qadams in a mixed set, and only those', async () => {
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [official, custom], includeFilters: true })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(mockInstall.mock.calls[0]?.[0]).toMatchObject({
            filtersPath: [expect.stringContaining(custom.qadamName)],
        })
        expect(await pathExists(readyFilePath(custom))).toBe(true)
        expect(await pathExists(qadamDirPath(official))).toBe(false)
    })

    it('the workspaces glob matches the directory qadams are written to', async () => {
        const qadam = makeQadam('@aiqadam/qadam-workspace')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [qadam], includeFilters: true })

        expect(await pathExists(join(qadamDirPath(qadam), 'node_modules'))).toBe(true)
    })

    it('a second install of the same set is a no-op', async () => {
        const qadam1 = makeQadam('@aiqadam/qadam-idempotent-a')
        const qadam2 = makeQadam('@aiqadam/qadam-idempotent-b')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [qadam1, qadam2], includeFilters: true })
        expect(mockInstall).toHaveBeenCalledOnce()

        // Nothing memoises these qadams yet — the in-process memo is only written by a disk check
        // that already found them installed — so the second run has to reach that conclusion from
        // the cache directory alone, which is what a second replica does too.
        await installer.install({ pieces: [qadam1, qadam2], includeFilters: true })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(qadam1))).toBe(true)
        expect(await pathExists(readyFilePath(qadam2))).toBe(true)
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

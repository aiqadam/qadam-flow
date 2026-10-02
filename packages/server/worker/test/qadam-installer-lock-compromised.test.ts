import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const settings = vi.hoisted(() => ({
    officialQadamsInstallEnabled: false,
}))
const mockVerifyOfficialQadams = vi.hoisted(() => vi.fn())

// Distinct bytes: what a rollback must not do is put the first back over the second.
const SNAPSHOTTED_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "snapshotted-before-install": [] } }\n'
const NEW_HOLDER_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "written-by-the-new-holder": [] } }\n'
const NEW_HOLDER_FILE = 'written-by-the-new-holder'

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
        verifyOfficialQadams: mockVerifyOfficialQadams,
        refusedKeysIn: vi.fn(() => new Set()),
    }),
}))

vi.mock('../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: () => ({
            EXECUTION_MODE: 'UNSANDBOXED',
            DEV_QADAMS: [],
            OFFICIAL_QADAMS_INSTALL_ENABLED: settings.officialQadamsInstallEnabled,
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
    settings.officialQadamsInstallEnabled = false
    mockInstall.mockReset()
    mockVerifyOfficialQadams.mockReset()
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
    // #593: every rollback writes the shared workspace, and once the lock is lost the files it
    // would remove or restore are the new holder's. Each test below lets a "new holder" write its
    // own lockfile and member file at the moment the lock is lost, then checks both survive.
    describe('leaves the workspace to the new holder on every rollback path', () => {
        it('a single-qadam batch failure removes no directory and restores no lockfile', async () => {
            settings.officialQadamsInstallEnabled = true
            const qadam = makeQadam('@acme/qadam-a')
            await writeFile(lockfilePath(), SNAPSHOTTED_LOCKFILE)
            mockInstall.mockImplementation(async () => {
                await takeOverWorkspace({ qadam })
                throw new Error('batch install failed')
            })

            await expect(install([qadam])).rejects.toThrow('batch install failed')

            expect(await readFile(lockfilePath(), 'utf8')).toBe(NEW_HOLDER_LOCKFILE)
            expect(await pathExists(newHolderFilePath(qadam))).toBe(true)
        })

        it('a failed one-by-one retry does not remove that qadam\'s directory', async () => {
            const qadamA = makeQadam('@acme/qadam-a')
            const qadamB = makeQadam('@acme/qadam-b')
            mockInstall
                .mockImplementationOnce(async () => {
                    throw new Error('batch install failed')
                })
                .mockImplementationOnce(async () => {
                    await takeOverWorkspace({ qadam: qadamA })
                    throw new Error('retry failed')
                })

            await expect(install([qadamA, qadamB])).rejects.toThrow('Lost the lock')

            expect(mockInstall).toHaveBeenCalledTimes(2)
            expect(await pathExists(newHolderFilePath(qadamA))).toBe(true)
        })

        it('no survivor after the one-by-one retry restores no lockfile', async () => {
            settings.officialQadamsInstallEnabled = true
            const qadamA = makeQadam('@acme/qadam-a')
            const qadamB = makeQadam('@acme/qadam-b')
            await writeFile(lockfilePath(), SNAPSHOTTED_LOCKFILE)
            mockInstall
                .mockImplementationOnce(async () => {
                    throw new Error('batch install failed')
                })
                .mockImplementationOnce(async () => {
                    throw new Error('retry failed')
                })
                // Lost on the last retry, so the loop ends without another lock check and the
                // no-survivor restore is what runs next.
                .mockImplementationOnce(async () => {
                    await takeOverWorkspace({ qadam: qadamB })
                    throw new Error('retry failed')
                })

            await expect(install([qadamA, qadamB])).rejects.toThrow('Failed to install')

            expect(mockInstall).toHaveBeenCalledTimes(3)
            expect(await readFile(lockfilePath(), 'utf8')).toBe(NEW_HOLDER_LOCKFILE)
            expect(await pathExists(newHolderFilePath(qadamB))).toBe(true)
        })

        it('an integrity failure after the last lock check removes no directory and restores no lockfile', async () => {
            settings.officialQadamsInstallEnabled = true
            const qadam = makeQadam('@acme/qadam-a')
            await writeFile(lockfilePath(), SNAPSHOTTED_LOCKFILE)
            mockInstall.mockResolvedValue({ output: '' })
            mockVerifyOfficialQadams.mockImplementation(async () => {
                await takeOverWorkspace({ qadam })
                throw new Error('[qadamIntegrity] refusing to install: @acme/qadam-a')
            })

            await expect(install([qadam])).rejects.toThrow('refusing to install')

            expect(await readFile(lockfilePath(), 'utf8')).toBe(NEW_HOLDER_LOCKFILE)
            expect(await pathExists(newHolderFilePath(qadam))).toBe(true)
        })
    })

    it('does not mark an install ready when the lock was lost while verification ran', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-a')
        mockInstall.mockResolvedValue({ output: '' })
        mockVerifyOfficialQadams.mockImplementation(async () => {
            lockStub.compromised = true
        })

        await expect(install([qadam])).rejects.toThrow('Lost the lock')

        expect(mockVerifyOfficialQadams).toHaveBeenCalledTimes(1)
        expect(await pathExists(join(qadamDirPath(qadam), 'ready'))).toBe(false)
    })
})

// What another replica does once it has taken the stale lock over: install into the same
// workspace, writing its own lockfile and its own files into the member directory.
async function takeOverWorkspace({ qadam }: { qadam: QadamPackage }): Promise<void> {
    lockStub.compromised = true
    await writeFile(lockfilePath(), NEW_HOLDER_LOCKFILE)
    await mkdir(qadamDirPath(qadam), { recursive: true })
    await writeFile(newHolderFilePath(qadam), 'true')
}

function lockfilePath(): string {
    return join(testWorkspace, 'bun.lock')
}

function qadamDirPath(qadam: QadamPackage): string {
    return join(testWorkspace, 'qadams', `${qadam.qadamName}-${qadam.qadamVersion}`)
}

function newHolderFilePath(qadam: QadamPackage): string {
    return join(qadamDirPath(qadam), NEW_HOLDER_FILE)
}

async function pathExists(target: string): Promise<boolean> {
    return access(target).then(() => true, () => false)
}

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

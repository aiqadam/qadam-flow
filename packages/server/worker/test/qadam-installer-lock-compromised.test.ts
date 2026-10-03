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
const mockRefusedKeysIn = vi.hoisted(() => vi.fn())
// Lets a test act at the moment the installer removes a directory.
const fsHook = vi.hoisted(() => ({
    onRm: async (_target: string): Promise<void> => undefined,
}))

// Distinct bytes: what a rollback must not do is put the first back over the second.
const SNAPSHOTTED_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "snapshotted-before-install": [] } }\n'
const NEW_HOLDER_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "written-by-the-new-holder": [] } }\n'
const NEW_HOLDER_FILE = 'written-by-the-new-holder'
// An official-scope alias the integrity pass refuses, brought in by the qadam being installed.
const REFUSED_KEY = 'decoy-alias'
const CLEAN_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "left-by-another-tenant": [] } }\n'
const INSTALLED_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "left-by-another-tenant": [], "@acme/qadam-x": [] } }\n'
const POISONED_LOCKFILE = `{ "lockfileVersion": 1, "packages": { "left-by-another-tenant": [], "@acme/qadam-x": [], "${REFUSED_KEY}": [] } }\n`

const mockInstall = vi.fn()
let testWorkspace = ''

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        default: actual,
        rm: async (target: string, options?: { recursive?: boolean, force?: boolean }): Promise<void> => {
            await fsHook.onRm(String(target))
            return actual.rm(target, options)
        },
    }
})

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
        refusedKeysIn: mockRefusedKeysIn,
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
    mockRefusedKeysIn.mockReset()
    mockRefusedKeysIn.mockImplementation(() => new Set())
    fsHook.onRm = async () => undefined
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

    it('a lock lost while the qadam directory is being removed restores no lockfile', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-a')
        await writeFile(lockfilePath(), SNAPSHOTTED_LOCKFILE)
        mockInstall.mockImplementation(async () => {
            throw new Error('batch install failed')
        })
        fsHook.onRm = async (target) => {
            if (target === qadamDirPath(qadam)) {
                lockStub.compromised = true
                await writeFile(lockfilePath(), NEW_HOLDER_LOCKFILE)
            }
        }

        await expect(install([qadam])).rejects.toThrow('batch install failed')

        expect(await readFile(lockfilePath(), 'utf8')).toBe(NEW_HOLDER_LOCKFILE)
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

// #593: what an abandoned install leaves behind (a member with no `ready` marker, and a lockfile
// nothing verified) is handled by the next install to take the lock.
describe('qadamInstaller after an install that stopped without rolling back', () => {
    // The path a skipped rollback opens: the lock is lost while the integrity pass runs, the pass
    // refuses the alias X brought in, and nothing is rolled back. When X is requested again — X is
    // then in the batch — the alias is already in bun.lock before that install runs, and counting
    // it as "refused before this install" would excuse it and mark X ready.
    it('fails the re-request of the same qadam closed, and keeps failing it after the rollback', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-x')
        await writeFile(lockfilePath(), CLEAN_LOCKFILE)
        mockRefusedKeysIn.mockImplementation(({ lockfileContents }: { lockfileContents: string | undefined }) =>
            new Set(lockfileContents?.includes(REFUSED_KEY) ? [REFUSED_KEY] : []))
        mockInstall.mockImplementation(async () => {
            await writeFile(lockfilePath(), POISONED_LOCKFILE)
            return { output: '' }
        })
        mockVerifyOfficialQadams.mockImplementation(refuseUnlessAlreadyRefused)
        mockVerifyOfficialQadams.mockImplementationOnce(async (params: VerifyParams) => {
            lockStub.compromised = true
            return refuseUnlessAlreadyRefused(params)
        })

        await expect(install([qadam])).rejects.toThrow('refusing to install')
        expect(await readFile(lockfilePath(), 'utf8')).toBe(POISONED_LOCKFILE)
        expect(await pathExists(qadamDirPath(qadam))).toBe(true)

        lockStub.compromised = false
        await expect(install([qadam])).rejects.toThrow('refusing to install')
        // The rollback of the re-request must not put the alias back where a third attempt, with
        // the leftover gone by then, would read it as already refused.
        await expect(install([qadam])).rejects.toThrow('refusing to install')

        expect(await pathExists(join(qadamDirPath(qadam), 'ready'))).toBe(false)
    })

    it('still retries a leftover of the same batch normally when the lockfile holds no refusal', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-x')
        await writeFile(lockfilePath(), CLEAN_LOCKFILE)
        await writeLeftoverMember({ qadam })
        // What bun needs to install the member at all: its own package.json, the one this install
        // wrote, still in place when bun runs.
        const memberSeenByBun: string[] = []
        mockInstall.mockImplementation(async () => {
            memberSeenByBun.push(await readFile(join(qadamDirPath(qadam), 'package.json'), 'utf8').catch(() => 'missing'))
            await writeFile(lockfilePath(), INSTALLED_LOCKFILE)
            return { output: '' }
        })
        mockVerifyOfficialQadams.mockImplementation(refuseUnlessAlreadyRefused)

        await install([qadam])

        expect(memberSeenByBun).toHaveLength(1)
        expect(JSON.parse(memberSeenByBun[0])).toMatchObject({ dependencies: { [qadam.qadamName]: qadam.qadamVersion } })
        expect(await readFile(lockfilePath(), 'utf8')).toBe(INSTALLED_LOCKFILE)
        expect(await pathExists(join(qadamDirPath(qadam), 'ready'))).toBe(true)
    })

    // Distrusting a lockfile with no refusal in it changes no verdict, so it must not cost the
    // shared lockfile either: removing it forces every tenant's qadams to re-resolve.
    it('restores the lockfile after a failed install when the leftover sits beside no refusal', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-x')
        await writeFile(lockfilePath(), CLEAN_LOCKFILE)
        await writeLeftoverMember({ qadam })
        mockInstall.mockImplementation(async () => {
            await writeFile(lockfilePath(), INSTALLED_LOCKFILE)
            throw new Error('batch install failed')
        })

        await expect(install([qadam])).rejects.toThrow('batch install failed')

        expect(await readFile(lockfilePath(), 'utf8')).toBe(CLEAN_LOCKFILE)
    })

    // bun 1.3.14 fails every install in a workspace with a member whose dependencies do not
    // resolve, `--filter` or not, so the leftover has to be gone before this install's bun runs.
    it('removes a leftover outside its batch before bun install, and leaves ready qadams alone', async () => {
        const leftover = makeQadam('@acme/qadam-left-behind')
        const readyQadam = makeQadam('@acme/qadam-ready')
        const qadam = makeQadam('@acme/qadam-x')
        await writeLeftoverMember({ qadam: leftover })
        await writeLeftoverMember({ qadam: readyQadam })
        await writeFile(join(qadamDirPath(readyQadam), 'ready'), 'true')
        const seenByBun: { leftover: boolean, ready: boolean }[] = []
        mockInstall.mockImplementation(async () => {
            seenByBun.push({
                leftover: await pathExists(qadamDirPath(leftover)),
                ready: await pathExists(qadamDirPath(readyQadam)),
            })
            return { output: '' }
        })

        await install([qadam])

        expect(seenByBun).toEqual([{ leftover: false, ready: true }])
    })

    // The leftovers are the only record that bun.lock holds a refusal nothing verified. An install
    // whose own setup fails before it has written members of its own must leave them in place, or
    // the next one trusts the lockfile and excuses the refusal.
    it('keeps the leftovers when the install fails before writing members of its own', async () => {
        settings.officialQadamsInstallEnabled = true
        const qadam = makeQadam('@acme/qadam-x')
        await writeLeftoverMember({ qadam })
        await writeFile(lockfilePath(), POISONED_LOCKFILE)
        mockRefusedKeysIn.mockImplementation(({ lockfileContents }: { lockfileContents: string | undefined }) =>
            new Set(lockfileContents?.includes(REFUSED_KEY) ? [REFUSED_KEY] : []))
        mockInstall.mockImplementation(async () => {
            await writeFile(lockfilePath(), POISONED_LOCKFILE)
            return { output: '' }
        })
        mockVerifyOfficialQadams.mockImplementation(refuseUnlessAlreadyRefused)
        // A write that fails in `createInstallWorkspaceFiles`, as ENOSPC or EIO would.
        await mkdir(join(testWorkspace, 'bunfig.toml'))

        await expect(install([makeQadam('@other/qadam-y')])).rejects.toThrow()
        expect(mockInstall).not.toHaveBeenCalled()
        expect(await pathExists(qadamDirPath(qadam))).toBe(true)

        await rm(join(testWorkspace, 'bunfig.toml'), { recursive: true })
        await expect(install([qadam])).rejects.toThrow('refusing to install')
        expect(await pathExists(join(qadamDirPath(qadam), 'ready'))).toBe(false)
    })

    // bun installs an ARCHIVE dependency named `foo/bar` at `qadams/foo/bar-1.0.0`, so
    // `qadams/foo` is not a member and must survive an unrelated install, flag off or on.
    it('keeps a ready qadam whose name holds a slash through an unrelated install', async () => {
        const slashed = makeQadam('foo/bar')
        await writeReadyMember({ qadam: slashed })
        mockInstall.mockResolvedValue({ output: '' })

        await install([makeQadam('@acme/qadam-x')])

        expect(await pathExists(join(qadamDirPath(slashed), 'ready'))).toBe(true)
    })

    // Directories already on disk can predate the npm-grammar check the installer now applies to
    // qadam names, so the layout under `qadams/` cannot be read off the first path segment: `a/b` puts a ready member inside a
    // directory that is not a member, and a bare `@foo` is a member, not a scope.
    it('removes only directories that are members, and never one holding a ready member', async () => {
        const slashed = makeQadam('acme/tools')
        const bareAt = makeQadam('@foo')
        const outer = makeQadam('@acme/qadam-outer')
        const nested = { ...makeQadam(`${outer.qadamName}-${outer.qadamVersion}/inner`), qadamVersion: '2.0.0' }
        const bareAtLeftover = makeQadam('@bar')
        await writeReadyMember({ qadam: slashed })
        await writeReadyMember({ qadam: bareAt })
        await mkdir(join(qadamDirPath(bareAt), 'node_modules'), { recursive: true })
        await writeLeftoverMember({ qadam: outer })
        await writeReadyMember({ qadam: nested })
        await writeLeftoverMember({ qadam: bareAtLeftover })
        mockInstall.mockResolvedValue({ output: '' })

        await install([makeQadam('@acme/qadam-x')])

        expect(await pathExists(join(qadamDirPath(slashed), 'ready'))).toBe(true)
        expect(await pathExists(join(qadamDirPath(bareAt), 'node_modules'))).toBe(true)
        expect(await pathExists(join(qadamDirPath(nested), 'ready'))).toBe(true)
        expect(await pathExists(qadamDirPath(bareAtLeftover))).toBe(false)
    })

    // The `@scope` directory above every scoped qadam has no `ready` of its own. Taking it for an
    // unfinished install would stop excusing a refusal every finished install in the workspace
    // already lives with.
    it('does not take a scope directory for an unfinished install', async () => {
        settings.officialQadamsInstallEnabled = true
        await writeReadyMember({ qadam: makeQadam('@acme/qadam-ready') })
        await writeFile(lockfilePath(), POISONED_LOCKFILE)
        mockRefusedKeysIn.mockImplementation(({ lockfileContents }: { lockfileContents: string | undefined }) =>
            new Set(lockfileContents?.includes(REFUSED_KEY) ? [REFUSED_KEY] : []))
        mockInstall.mockResolvedValue({ output: '' })
        mockVerifyOfficialQadams.mockImplementation(refuseUnlessAlreadyRefused)

        await install([makeQadam('@other/qadam-y')])

        expect(mockVerifyOfficialQadams).toHaveBeenCalledWith(expect.objectContaining({ refusedBeforeInstall: new Set([REFUSED_KEY]) }))
    })

    it('does not remove a leftover once the lock is lost', async () => {
        const leftover = makeQadam('@acme/qadam-left-behind')
        await writeLeftoverMember({ qadam: leftover })
        lockStub.compromised = true

        await expect(install([makeQadam('@acme/qadam-x')])).rejects.toThrow('Lost the lock')

        expect(await pathExists(qadamDirPath(leftover))).toBe(true)
    })
})

// Stands in for `reportRefusals`: a refusal fails the install unless it was refused before it ran.
async function refuseUnlessAlreadyRefused({ rootWorkspace, refusedBeforeInstall }: VerifyParams): Promise<void> {
    const lockfile = await readFile(join(rootWorkspace, 'bun.lock'), 'utf8')
    if (lockfile.includes(REFUSED_KEY) && !refusedBeforeInstall.has(REFUSED_KEY)) {
        throw new Error(`[qadamIntegrity] refusing to install: ${REFUSED_KEY}`)
    }
}

async function writeReadyMember({ qadam }: { qadam: QadamPackage }): Promise<void> {
    await writeLeftoverMember({ qadam })
    await writeFile(join(qadamDirPath(qadam), 'ready'), 'true')
}

// What a worker killed mid-install, or one that lost the lock, leaves: a member and no `ready`.
async function writeLeftoverMember({ qadam }: { qadam: QadamPackage }): Promise<void> {
    await mkdir(qadamDirPath(qadam), { recursive: true })
    await writeFile(join(qadamDirPath(qadam), 'package.json'), JSON.stringify({ name: `${qadam.qadamName}-${qadam.qadamVersion}` }))
}

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

type VerifyParams = {
    rootWorkspace: string
    refusedBeforeInstall: Set<string>
}

import { access, glob, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageType, QadamType } from '@aiqadam/shared'
import type { OfficialQadamPackage, QadamPackage } from '@aiqadam/shared'
import type { Logger } from 'pino'
import { qadamInstaller } from '../src/lib/cache/qadams/qadam-installer'

// Distinct bytes rather than realistic lockfiles: `qadam-integrity` is mocked in this file, so
// nothing here parses them. What the rollback tests need is only to tell three states apart —
// what was there before, what `bun install` wrote, and what a refused install must not leave.
const CLEAN_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "left-by-another-tenant": [] } }\n'
const INSTALLED_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "left-by-another-tenant": [], "@aiqadam/qadam-tables": [] } }\n'
const POISONED_LOCKFILE = '{ "lockfileVersion": 1, "packages": { "@aiqadam/qadam-tables": ["/tmp/squatter.tgz"] } }\n'

// Module-level variable updated per test so the vi.mock factory can reference it
let testWorkspace = ''
// Off by default, matching the real settings default — a test that needs the flag on
// overrides this before calling installer.install().
let officialQadamsInstallEnabled = false

const mockInstall = vi.fn()
const mockVerifyOfficialQadams = vi.fn()
const mockRefusedKeysIn = vi.fn()

vi.mock('../src/lib/cache/code/bun-runner', () => ({
    bunRunner: () => ({
        install: mockInstall,
    }),
}))

// Stubbed rather than exercised: what the real check reads is a `bun.lock` written by a real
// `bun install`, and it answers by fetching publisher signatures from npmjs. Both belong to
// qadam-integrity.test.ts, which drives them against a recorded registry response. What is left
// for this file — and what the tests at the bottom assert — is the wiring: that the installer
// calls it at all, that it calls it before writing the `ready` marker, and that it does not call
// it when OFFICIAL_QADAMS_INSTALL_ENABLED is off.
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
            OFFICIAL_QADAMS_INSTALL_ENABLED: officialQadamsInstallEnabled,
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
    officialQadamsInstallEnabled = false
    vi.clearAllMocks()
    mockInstall.mockReset()
    mockVerifyOfficialQadams.mockReset()
    mockVerifyOfficialQadams.mockResolvedValue(undefined)
    mockRefusedKeysIn.mockReset()
    // A non-empty set by default, so a test asserting the hand-off cannot pass on an installer
    // that quietly makes its own empty one.
    mockRefusedKeysIn.mockReturnValue(new Set(['@aiqadam/already-broken']))
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

    // OFFICIAL_QADAMS_INSTALL_ENABLED on: an official qadam is installed through the same
    // registry path a custom qadam already takes (#477). Off is the default and is covered by
    // the two tests directly above, which must keep passing byte for byte.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — an official qadam is selected for installation', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [official], includeFilters: true })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(mockInstall.mock.calls[0]?.[0]).toMatchObject({
            filtersPath: [expect.stringContaining(`${official.qadamName}-${official.qadamVersion}`)],
        })
        expect(await pathExists(readyFilePath(official))).toBe(true)
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — installs both the official and custom qadams in a mixed set', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [official, custom], includeFilters: true })

        expect(mockInstall).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(official))).toBe(true)
        expect(await pathExists(readyFilePath(custom))).toBe(true)
    })

    // #482 items 2 and 3. Both files have to land in the workspace bun installs FROM, because
    // bun reads `.npmrc` and `bunfig.toml` from the install cwd and `$HOME` and does not walk up
    // the tree — so the repo-root copies of both are not in force here and never were.
    it('pins the @aiqadam scope in the .npmrc bun actually reads', async () => {
        const qadam = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [qadam], includeFilters: true })

        const npmrc = await readFile(join(testWorkspace, '.npmrc'), 'utf8')
        expect(npmrc).toContain('@aiqadam:registry=https://registry.npmjs.org/')
    })

    it('quarantines fresh releases, exempting only the admin-chosen custom names', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [official, custom], includeFilters: true })

        const bunfig = await readFile(join(testWorkspace, 'bunfig.toml'), 'utf8')
        expect(bunfig).toContain('minimumReleaseAge = 259200')
        // An administrator typed this name, so blocking their own fresh publish for three days
        // would break iterating on a private qadam — a workflow that works today.
        expect(bunfig).toContain('minimumReleaseAgeExcludes = ["@acme/qadam-internal"]')
        // The official catalogue is chosen by nobody, which is the whole reason item 3 exists.
        expect(bunfig).not.toContain(official.qadamName)
        // The repo-root bunfig also sets `linker = "isolated"`. Left out because an inherited
        // default that already matches is not worth restating — NOT because copying it would
        // change the layout, which is the claim `buildInstallBunfig`'s own comment retracts.
        expect(bunfig).not.toContain('linker')
    })

    // The exemption is decided by qadamType but written as a NAME, and a platform can register a
    // CUSTOM qadam under an official name — qadamMetadataService.create validates no names and
    // scopes uniqueness by platformId. Without the scope filter, one platform's naming choice
    // would lift the quarantine off an official name for every tenant sharing the workspace.
    it('never exempts an official name, even when a custom qadam is registered under one', async () => {
        const squatter = makeQadam('@aiqadam/qadam-slack')
        const genuine = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [squatter, genuine], includeFilters: true })

        const bunfig = await readFile(join(testWorkspace, 'bunfig.toml'), 'utf8')
        expect(bunfig).toContain('minimumReleaseAgeExcludes = ["@acme/qadam-internal"]')
        expect(bunfig).not.toContain('@aiqadam/qadam-slack')
    })

    it('never writes a name that is not a package name into the excludes array', async () => {
        const injected = makeQadam('@acme/x"]\nregistry = "http://evil.example')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [injected], includeFilters: true })

        const bunfig = await readFile(join(testWorkspace, 'bunfig.toml'), 'utf8')
        expect(bunfig).toContain('minimumReleaseAgeExcludes = []')
        expect(bunfig).not.toContain('evil.example')
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

    // #482 item 4. `ready` is what makes every later install skip the qadam entirely, so a batch
    // recorded as usable is a batch nothing will look at again — the check has to have answered
    // before the marker exists, not merely have been called at some point in the run.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — verifies publisher signatures before marking ready', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)
        let readyExistedDuringVerification = true
        mockVerifyOfficialQadams.mockImplementation(async () => {
            readyExistedDuringVerification = await pathExists(readyFilePath(official))
        })

        await installer.install({ pieces: [official], includeFilters: true })

        // The batch goes with it, not just the workspace: the check reads the whole shared
        // workspace, so this is the only thing telling it which entries THIS install introduced.
        expect(mockVerifyOfficialQadams).toHaveBeenCalledWith({
            rootWorkspace: testWorkspace,
            installed: [official],
            refusedBeforeInstall: new Set(['@aiqadam/already-broken']),
        })
        expect(readyExistedDuringVerification).toBe(false)
        expect(await pathExists(readyFilePath(official))).toBe(true)
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — an unverifiable install is rolled back, not marked ready', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)
        mockVerifyOfficialQadams.mockRejectedValue(new Error('[qadamIntegrity] refusing @aiqadam/qadam-tables@1.0.0'))

        await expect(installer.install({ pieces: [official], includeFilters: true }))
            .rejects.toThrow('[qadamIntegrity] refusing @aiqadam/qadam-tables@1.0.0')

        expect(await pathExists(qadamDirPath(official))).toBe(false)
    })

    // The fallback loop installs one qadam at a time, but bun resolves every workspace member
    // regardless of `--filter`, so what lands on disk is never one qadam's graph. Verifying per
    // iteration would therefore blame whichever qadam happened to be in hand; one pass over the
    // whole workspace afterwards is the only reading that matches what bun wrote.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — the individual fallback verifies once, after the loop', async () => {
        officialQadamsInstallEnabled = true
        const qadam1 = makeOfficialQadam('@aiqadam/qadam-tables')
        const qadam2 = makeOfficialQadam('@aiqadam/qadam-subflows')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall
            .mockRejectedValueOnce(new Error('batch error'))
            .mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [qadam1, qadam2], includeFilters: false })

        expect(mockInstall).toHaveBeenCalledTimes(3)
        expect(mockVerifyOfficialQadams).toHaveBeenCalledOnce()
        expect(await pathExists(readyFilePath(qadam1))).toBe(true)
        expect(await pathExists(readyFilePath(qadam2))).toBe(true)
    })

    // Off is the default, and with it no official qadam is installed at all. Running the check
    // anyway would put a hard dependency on npmjs reachability onto the plain custom-qadam path,
    // which has none today: every qadam pins @aiqadam/shared, @aiqadam/qadams-framework and
    // @aiqadam/qadams-common, so all three are in a custom install's lockfile too.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED off — a custom install never reaches the registry', async () => {
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [custom], includeFilters: true })

        expect(mockVerifyOfficialQadams).not.toHaveBeenCalled()
        expect(await pathExists(readyFilePath(custom))).toBe(true)
    })

    // The pre-install reading is the only thing that can tell an entry THIS install wrote from one
    // that was already in the shared workspace, and the two get different answers — so it has to
    // happen before `bun install`, not after. Read it afterwards and every refusal looks
    // pre-existing, which is the fail-open the batch rule it replaced already had.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — reads the refused keys before bun install runs', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        const order: string[] = []
        mockRefusedKeysIn.mockImplementation(() => {
            order.push('read')
            return new Set<string>()
        })
        mockInstall.mockImplementation(async (params: { path: string, filtersPath: string[] }) => {
            order.push('install')
            return simulateBunInstall(params)
        })

        await installer.install({ pieces: [official], includeFilters: true })

        expect(order).toEqual(['read', 'install'])
    })

    // Off the flag as well as the verification itself. With the flag off nothing verifies, so the
    // read would be a file stat and a JSONC parse bought for nothing on every custom install.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED off — does not read the lockfile either', async () => {
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(simulateBunInstall)

        await installer.install({ pieces: [custom], includeFilters: true })

        expect(mockRefusedKeysIn).not.toHaveBeenCalled()
    })

    // The one that makes the pre-install reading mean anything. `bun install` rewrites `bun.lock`
    // before the check reads it, so a refused install that leaves its own output on disk has
    // written the very "already refused" baseline the retry will classify against — and the retry
    // then waves through exactly what the first attempt refused. The gate would hold for one
    // attempt and no more, which is indistinguishable from not holding, because a batch with no
    // `ready` marker is reinstalled by the next job automatically.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — a refused install leaves the retry the lockfile it saw, not its own', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await writeFile(lockfile, CLEAN_LOCKFILE)

        mockInstall.mockImplementation(async (params: { path: string, filtersPath: string[] }) => {
            await writeFile(lockfile, POISONED_LOCKFILE)
            return simulateBunInstall(params)
        })
        mockVerifyOfficialQadams.mockRejectedValue(new Error('[qadamIntegrity] refusing to install: @aiqadam/qadam-tables'))
        const classified: (string | undefined)[] = []
        mockRefusedKeysIn.mockImplementation(({ lockfileContents }: { lockfileContents: string | undefined }) => {
            classified.push(lockfileContents)
            return new Set<string>()
        })

        await expect(installer.install({ pieces: [official], includeFilters: true })).rejects.toThrow()
        await expect(installer.install({ pieces: [official], includeFilters: true })).rejects.toThrow()

        expect(classified).toEqual([CLEAN_LOCKFILE, CLEAN_LOCKFILE])
        expect(await readFile(lockfile, 'utf8')).toBe(CLEAN_LOCKFILE)
    })

    // Restored, not deleted — except where there was nothing to restore. The workspace is shared by
    // every tenant, so the lockfile carries resolutions this batch never touched; deleting it to
    // undo one install would throw those away too.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — a refused first install leaves no lockfile behind', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')

        mockInstall.mockImplementation(async (params: { path: string, filtersPath: string[] }) => {
            await writeFile(lockfile, POISONED_LOCKFILE)
            return simulateBunInstall(params)
        })
        mockVerifyOfficialQadams.mockRejectedValue(new Error('[qadamIntegrity] refusing to install: @aiqadam/qadam-tables'))

        await expect(installer.install({ pieces: [official], includeFilters: true })).rejects.toThrow()

        expect(await pathExists(lockfile)).toBe(false)
    })

    // The other half of the same rule: an install that PASSES must keep what bun resolved. A
    // rollback that fired unconditionally would restore the pre-install lockfile over a good
    // install and leave the workspace describing a tree that is no longer on disk.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — a verified install keeps the lockfile bun wrote', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await writeFile(lockfile, CLEAN_LOCKFILE)

        mockInstall.mockImplementation(async (params: { path: string, filtersPath: string[] }) => {
            await writeFile(lockfile, INSTALLED_LOCKFILE)
            return simulateBunInstall(params)
        })

        await installer.install({ pieces: [official], includeFilters: true })

        expect(await readFile(lockfile, 'utf8')).toBe(INSTALLED_LOCKFILE)
    })

    // With the flag off the snapshot is never taken, and "not taken" must not read as "there was
    // no lockfile" — that reading turns the restore into a delete, and the file being deleted
    // belongs to every tenant sharing the workspace, not to this batch. This is the default
    // configuration, so a failing one-piece install is the ordinary case: a custom qadam whose
    // version 404s, one published inside the `minimumReleaseAge` window, a corrupt archive, a
    // network blip.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED off — a failed install leaves the shared lockfile alone', async () => {
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await writeFile(lockfile, CLEAN_LOCKFILE)

        mockInstall.mockRejectedValueOnce(new Error('install failure'))

        await expect(installer.install({ pieces: [custom], includeFilters: true })).rejects.toThrow('install failure')

        expect(await readFile(lockfile, 'utf8')).toBe(CLEAN_LOCKFILE)
    })

    // Same conflation, reached through the individual-fallback loop instead of the one-piece
    // branch.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED off — a wholly failed batch leaves the shared lockfile alone', async () => {
        const custom1 = makeQadam('@acme/qadam-internal')
        const custom2 = makeQadam('@acme/qadam-other')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await writeFile(lockfile, CLEAN_LOCKFILE)

        mockInstall.mockRejectedValue(new Error('install failure'))

        await expect(installer.install({ pieces: [custom1, custom2], includeFilters: true })).rejects.toThrow()

        expect(await readFile(lockfile, 'utf8')).toBe(CLEAN_LOCKFILE)
    })

    // The abandoning-rollback guarantee has to cover the fallback loop's own total failure. No
    // piece survives, so nothing marks `ready` and the next job reinstalls the batch — reading
    // whatever bun left as its "already refused before this install" baseline unless it is undone.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — a batch whose every individual install fails restores the lockfile', async () => {
        officialQadamsInstallEnabled = true
        const official1 = makeOfficialQadam('@aiqadam/qadam-tables')
        const official2 = makeOfficialQadam('@aiqadam/qadam-subflows')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await writeFile(lockfile, CLEAN_LOCKFILE)

        mockInstall.mockImplementation(async () => {
            await writeFile(lockfile, POISONED_LOCKFILE)
            throw new Error('install failure')
        })

        await expect(installer.install({ pieces: [official1, official2], includeFilters: false })).rejects.toThrow()

        expect(await readFile(lockfile, 'utf8')).toBe(CLEAN_LOCKFILE)
    })

    // `workerSettings.set` runs at runtime on socket connect, so the flag can flip mid-install.
    // One install must answer from one reading of it: an off→on flip between the pre-install
    // snapshot and the integrity check would otherwise leave the check with nothing to restore,
    // and the abandoned attempt's own lockfile becomes its successor's baseline — the exact
    // one-attempt-only gate the rest of this file exists to close.
    it('decides on one reading of the flag, even if it flips mid-install', async () => {
        const custom = makeQadam('@acme/qadam-internal')
        const installer = qadamInstaller(fakeLog, fakeApiClient)

        mockInstall.mockImplementation(async (params: { path: string, filtersPath: string[] }) => {
            officialQadamsInstallEnabled = true
            return simulateBunInstall(params)
        })

        await installer.install({ pieces: [custom], includeFilters: true })

        // The snapshot was skipped because the flag was off when this install started. Verifying
        // on the flipped-on value would pair a check that can fail closed with a rollback holding
        // nothing to restore — so the check must answer to the same reading the snapshot did.
        expect(mockRefusedKeysIn).not.toHaveBeenCalled()
        expect(mockVerifyOfficialQadams).not.toHaveBeenCalled()
    })

    // A lockfile that exists but cannot be read is not an absent one. Collapsing the two makes the
    // rollback delete a file whose contents it never captured — Finding 1's blast radius reached
    // through a transient EACCES/EIO instead of through the flag.
    it('OFFICIAL_QADAMS_INSTALL_ENABLED on — an unreadable lockfile fails the install rather than being deleted', async () => {
        officialQadamsInstallEnabled = true
        const official = makeOfficialQadam('@aiqadam/qadam-tables')
        const installer = qadamInstaller(fakeLog, fakeApiClient)
        const lockfile = join(testWorkspace, 'bun.lock')
        await mkdir(lockfile, { recursive: true })

        mockInstall.mockImplementation(simulateBunInstall)

        await expect(installer.install({ pieces: [official], includeFilters: true })).rejects.toThrow(/bun\.lock/)

        expect(mockInstall).not.toHaveBeenCalled()
        expect(await pathExists(lockfile)).toBe(true)
    })
})

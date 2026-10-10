import fs from 'fs/promises'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
// The store's writer builds the fixtures. Engine code reads through the reader entry only.
import { QadamVersionOrigin, QadamVersionPutStatus, qadamVersionStore, QadamVersionStore, QadamVersionStoreLogger } from '../../../utils/src/qadam-version-store'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'

// ADR-0003 / #779: an official step pinned to `name@version` loads that version's own code from the
// qadam version store when the worker handed the engine a store, and the platform provides
// `@aiqadam/*` and `zod` to it.
const PROBE = '@aiqadam/qadam-store-probe'
const SUBFLOWS = '@aiqadam/qadam-subflows'
// A snapshot of the probe, the version a build from `main` gives a changed qadam (ADR-0004).
const SNAPSHOT = '1.3.0-main.412'
const PLATFORM_ID = 'AAAAAAAAAAAAAAAAAAAAA'
const STORE_LOG: QadamVersionStoreLogger = { info: () => undefined, warn: () => undefined }

// What a stored version does at load: build a qadam with the framework the platform provides, and
// report what else it could and could not reach.
const PROBE_SOURCE = `
const framework = require('@aiqadam/qadams-framework')
const zod = require('zod')
function attempt(name) { try { return require(name).marker } catch (e) { return e.code } }
function outcome(name) { try { require(name); return 'resolved' } catch (e) { return e.code } }
exports.probe = framework.createQadam({
    displayName: 'Store probe',
    auth: framework.QadamAuth.None(),
    logoUrl: 'https://example.com/logo.svg',
    authors: [],
    actions: [framework.createAction({ name: 'probe', displayName: 'Probe', description: '', props: {}, run: async () => 'ran' })],
    triggers: [],
})
exports.reached = {
    framework,
    zod,
    zodV4: require('zod/v4'),
    common: require('@aiqadam/qadams-common'),
    dependency: require('dependency-with-private-zod'),
    escapes: {
        throughShared: outcome('@aiqadam/shared/../../../../../../../../../../etc/hostname'),
        throughCommon: outcome('@aiqadam/qadams-common/../framework/package.json'),
        throughZod: outcome('zod/./package.json'),
    },
    own: attempt('own-dependency'),
    reservedNodeModules: attempt('outside-the-version'),
    builtin: typeof require('node:path').join,
}
`

let tempDir: string
let root: string
let store: QadamVersionStore
let subflowsVersion: string
let previousStorePath: string | undefined

beforeAll(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-qadam-store-')))
    root = path.join(tempDir, 'store')
    const opened = await qadamVersionStore.open({ root, log: STORE_LOG })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    store = opened.store
    subflowsVersion = await readVersion('packages/qadams/core/subflows/package.json')
    await storeVersion({ name: PROBE, version: '1.2.3', entrySource: PROBE_SOURCE })
    await storeVersion({ name: PROBE, version: SNAPSHOT, entrySource: PROBE_SOURCE })
    await storeVersion({ platformId: PLATFORM_ID, name: 'acme-crm', version: '1.0.0', entrySource: PROBE_SOURCE })
    // The same version the image bundles: the store's copy wins.
    await storeVersion({ name: SUBFLOWS, version: subflowsVersion, entrySource: PROBE_SOURCE })
    // The reserved `qadams/node_modules` is above every version, so Node's upward walk reaches it.
    // Nothing outside a version may answer for it, the same as `NODE_PATH`.
    await writeFiles({
        dir: path.join(root, 'qadams', 'node_modules', 'outside-the-version'),
        files: { 'package.json': JSON.stringify({ name: 'outside-the-version', main: 'index.js' }), 'index.js': 'exports.marker = "found outside"\n' },
    })
    previousStorePath = process.env.AP_QADAM_VERSION_STORE_PATH
    process.env.AP_QADAM_VERSION_STORE_PATH = root
})

afterAll(async () => {
    if (previousStorePath === undefined) {
        delete process.env.AP_QADAM_VERSION_STORE_PATH
    }
    else {
        process.env.AP_QADAM_VERSION_STORE_PATH = previousStorePath
    }
    await fs.rm(tempDir, { recursive: true, force: true })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('qadamLoader with a qadam version store', () => {
    it('loads a version only the store holds, logging where it came from', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        const { qadamAction } = await qadamLoader.getQadamAndActionOrThrow({ qadamName: PROBE, qadamVersion: '1.2.3', actionName: 'probe', devQadams: [] })

        expect(qadamAction.name).toBe('probe')
        const line = logSpy.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith(`[qadamLoader] cold load {"qadam":"${PROBE}@1.2.3"`))
        expect(JSON.parse(String(line).slice('[qadamLoader] cold load '.length))).toMatchObject({ resolvedVersion: '1.2.3', source: 'store' })
    })

    it('loads a stored snapshot pinned as name@x.y.z-main.<n>, and finds no other version in its alias', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        const { qadamAction } = await qadamLoader.getQadamAndActionOrThrow({ qadamName: PROBE, qadamVersion: SNAPSHOT, actionName: 'probe', devQadams: [] })

        expect(qadamAction.name).toBe('probe')
        const resolved = await qadamLoader.getQadamPath({ packageName: `${PROBE}@${SNAPSHOT}`, devQadams: [] })
        expect(resolved).toBe(path.join(root, 'qadams', PROBE, SNAPSHOT, 'src', 'index.js'))
        const line = logSpy.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith(`[qadamLoader] cold load {"qadam":"${PROBE}@${SNAPSHOT}"`))
        expect(JSON.parse(String(line).slice('[qadamLoader] cold load '.length))).toMatchObject({ resolvedVersion: SNAPSHOT, source: 'store' })
    })

    it('still reads the legacy name-version alias of a stored snapshot', async () => {
        const resolved = await qadamLoader.getQadamPath({ packageName: `${PROBE}-${SNAPSHOT}`, devQadams: [] })

        expect(resolved).toBe(path.join(root, 'qadams', PROBE, SNAPSHOT, 'src', 'index.js'))
    })

    it('does not stand a stored release in for a snapshot the store does not hold', async () => {
        await expect(qadamLoader.getQadamPath({ packageName: `${PROBE}@1.3.0-main.411`, devQadams: [] })).rejects.toThrow('Qadam not found')
        await expect(qadamLoader.getQadamPath({ packageName: `${PROBE}@1.3.0`, devQadams: [] })).rejects.toThrow('Qadam not found')
    })

    it('gives a stored version the platform\'s one copy of the framework, common and zod', async () => {
        const reached = await loadReached({ name: PROBE, version: '1.2.3' })
        const platform = createRequire(path.resolve('packages/qadams/common/package.json'))

        const framework = createRequire(path.resolve('packages/qadams/framework/package.json'))

        expect(reached.framework).toBe(framework('.'))
        expect(reached.zod).toBe(framework('zod'))
        expect(reached.zodV4).toBe(framework('zod/v4'))
        expect(reached.common).toBe(platform('.'))
        expect(reached.builtin).toBe('function')
    })

    it('gives the qadam\'s own code the platform\'s zod even with a copy beside it, and a dependency its private nested copy', async () => {
        const reached = await loadReached({ name: PROBE, version: '1.2.3' })
        const framework = createRequire(path.resolve('packages/qadams/framework/package.json'))

        expect(reached.zod).toBe(framework('zod'))
        expect(reached.dependency).toEqual({ zod: 'private nested copy', framework: framework('.') })
    })

    it('refuses a provided package\'s subpath that leaves the package', async () => {
        const reached = await loadReached({ name: PROBE, version: '1.2.3' })

        expect(reached.escapes).toEqual({ throughShared: 'MODULE_NOT_FOUND', throughCommon: 'MODULE_NOT_FOUND', throughZod: 'MODULE_NOT_FOUND' })
    })

    it('guards a custom version under its platform\'s namespace the same way', async () => {
        await loadReached({ name: PROBE, version: '1.2.3' })
        const entry = path.join(root, 'qadams', '_platform', PLATFORM_ID, 'acme-crm', '1.0.0', 'src', 'index.js')
        const loaded: unknown = await import(entry)
        if (typeof loaded !== 'object' || loaded === null || !('reached' in loaded) || typeof loaded.reached !== 'object' || loaded.reached === null) {
            throw new Error('the stored version exported nothing')
        }
        const reached = { ...loaded.reached }
        const framework = createRequire(path.resolve('packages/qadams/framework/package.json'))

        expect('framework' in reached && reached.framework).toBe(framework('.'))
        expect('own' in reached && reached.own).toBe('inside the version')
        expect('reservedNodeModules' in reached && reached.reservedNodeModules).toBe('MODULE_NOT_FOUND')
    })

    it('lets a stored version reach its own dependencies and nothing else outside it', async () => {
        const reached = await loadReached({ name: PROBE, version: '1.2.3' })

        expect(reached.own).toBe('inside the version')
        expect(reached.reservedNodeModules).toBe('MODULE_NOT_FOUND')
    })

    it('prefers the store to the image\'s build of the same version, on the copy of the framework already loaded', async () => {
        await qadamLoader.loadQadamOrThrow({ qadamName: PROBE, qadamVersion: '1.2.3', devQadams: [] })
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        await qadamLoader.loadQadamOrThrow({ qadamName: SUBFLOWS, qadamVersion: subflowsVersion, devQadams: [] })
        const resolved = await qadamLoader.getQadamPath({ packageName: `${SUBFLOWS}-${subflowsVersion}`, devQadams: [] })

        expect(resolved).toBe(path.join(root, 'qadams', SUBFLOWS, subflowsVersion, 'src', 'index.js'))
        const line = logSpy.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith(`[qadamLoader] cold load {"qadam":"${SUBFLOWS}@`))
        expect(JSON.parse(String(line).slice('[qadamLoader] cold load '.length))).toMatchObject({ source: 'store', sharedDepsAlreadyLoaded: true })
    })

    it('falls back to the image\'s build for a version the store does not hold', async () => {
        const delayVersion = await readVersion('packages/qadams/core/delay/package.json')

        const resolved = await qadamLoader.getQadamPath({ packageName: `@aiqadam/qadam-delay-${delayVersion}`, devQadams: [] })

        expect(resolved).toContain(path.join('packages', 'qadams', 'core', 'delay', 'dist'))
    })

    it('falls back to the image\'s build, once warned, when the stored version is damaged', async () => {
        const version = '2.0.0'
        await storeVersion({ name: PROBE, version, entrySource: PROBE_SOURCE })
        await fs.rm(path.join(root, 'qadams', PROBE, version, 'integrity.json'))
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await expect(qadamLoader.getQadamPath({ packageName: `${PROBE}-${version}`, devQadams: [] })).rejects.toThrow('Qadam not found')

        const warnings = warnSpy.mock.calls.map((call) => String(call[0]))
        expect(warnings).toEqual([`[qadamVersionStore] The stored version cannot be used, loading the image's build instead ${JSON.stringify({ qadam: `${PROBE}@${version}`, status: 'damaged', reason: 'integrity.json is missing' })}`])
        expect(warnings.join('\n')).not.toContain(tempDir)
    })
})

async function loadReached({ name, version }: { name: string, version: string }): Promise<Record<string, unknown>> {
    const entry = await qadamLoader.getQadamPath({ packageName: `${name}-${version}`, devQadams: [] })
    const loaded: unknown = await import(entry)
    if (typeof loaded !== 'object' || loaded === null || !('reached' in loaded) || typeof loaded.reached !== 'object' || loaded.reached === null) {
        throw new Error('the stored version exported nothing')
    }
    return { ...loaded.reached }
}

async function storeVersion({ platformId = null, name, version, entrySource }: StoreVersionParams): Promise<void> {
    const stagingDir = await store.createStaging()
    await writeFiles({
        dir: stagingDir,
        files: {
            'package.json': JSON.stringify({
                name,
                version,
                main: './src/index.js',
                peerDependencies: { '@aiqadam/qadams-framework': '*', '@aiqadam/qadams-common': '*', 'zod': '*' },
            }),
            'src/index.js': entrySource,
            'metadata.json': JSON.stringify({ name, version, displayName: name, actions: {}, triggers: {} }),
            'node_modules/own-dependency/package.json': JSON.stringify({ name: 'own-dependency', version: '1.0.0', main: 'index.js' }),
            'node_modules/own-dependency/index.js': 'exports.marker = "inside the version"\n',
            // A copy beside the qadam's own code: the platform's still wins for it.
            'src/node_modules/zod/package.json': JSON.stringify({ name: 'zod', version: '0.0.1', main: 'index.js' }),
            'src/node_modules/zod/index.js': 'exports.marker = "a copy beside the qadam"\n',
            // A third-party dependency with a private copy nested under it keeps that copy.
            'node_modules/dependency-with-private-zod/package.json': JSON.stringify({ name: 'dependency-with-private-zod', version: '1.0.0', main: 'index.js' }),
            'node_modules/dependency-with-private-zod/index.js': 'exports.zod = require("zod").marker\nexports.framework = require("@aiqadam/qadams-framework")\n',
            'node_modules/dependency-with-private-zod/node_modules/zod/package.json': JSON.stringify({ name: 'zod', version: '3.0.0', main: 'index.js' }),
            'node_modules/dependency-with-private-zod/node_modules/zod/index.js': 'exports.marker = "private nested copy"\n',
        },
    })
    const result = await store.commit({ coordinates: { platformId, name, version }, stagingDir, origin: { kind: QadamVersionOrigin.ARCHIVE, tarballIntegrity: null } })
    if (result.status !== QadamVersionPutStatus.STORED) {
        throw new Error(`could not store ${name}@${version}: ${result.status === QadamVersionPutStatus.REFUSED ? result.reason : result.status}`)
    }
}

type StoreVersionParams = {
    platformId?: string | null
    name: string
    version: string
    entrySource: string
}

async function writeFiles({ dir, files }: { dir: string, files: Record<string, string> }): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
        await fs.writeFile(path.join(dir, file), content)
    }
}

async function readVersion(packageJsonPath: string): Promise<string> {
    const packageJson: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
    if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson) || typeof packageJson.version !== 'string') {
        throw new Error(`${packageJsonPath} has no version`)
    }
    return packageJson.version
}

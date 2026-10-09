import fs from 'fs/promises'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { QadamVersionOrigin, QadamVersionPutStatus, qadamVersionStore, QadamVersionStore, QadamVersionStoreLogger } from '@aiqadam/server-utils/qadam-version-store'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'

// ADR-0003 / #779: an official step pinned to `name@version` loads that version's own code from the
// qadam version store when the worker handed the engine a store, and the platform provides
// `@aiqadam/*` and `zod` to it.
const PROBE = '@aiqadam/qadam-store-probe'
const SUBFLOWS = '@aiqadam/qadam-subflows'
const STORE_LOG: QadamVersionStoreLogger = { info: () => undefined, warn: () => undefined }

// What a stored version does at load: build a qadam with the framework the platform provides, and
// report what else it could and could not reach.
const PROBE_SOURCE = `
const framework = require('@aiqadam/qadams-framework')
const zod = require('zod')
function attempt(name) { try { return require(name).marker } catch (e) { return e.code } }
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
    common: require('@aiqadam/qadams-common'),
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

    it('gives a stored version the platform\'s one copy of the framework, common and zod', async () => {
        const reached = await loadReached({ name: PROBE, version: '1.2.3' })
        const platform = createRequire(path.resolve('packages/qadams/common/package.json'))

        expect(reached.framework).toBe(platform('@aiqadam/qadams-framework'))
        expect(reached.zod).toBe(platform('zod'))
        expect(reached.common).toBe(platform('.'))
        expect(reached.builtin).toBe('function')
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

async function storeVersion({ name, version, entrySource }: { name: string, version: string, entrySource: string }): Promise<void> {
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
        },
    })
    const result = await store.commit({ coordinates: { platformId: null, name, version }, stagingDir, origin: { kind: QadamVersionOrigin.ARCHIVE, tarballIntegrity: null } })
    if (result.status !== QadamVersionPutStatus.STORED) {
        throw new Error(`could not store ${name}@${version}: ${result.status === QadamVersionPutStatus.REFUSED ? result.reason : result.status}`)
    }
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

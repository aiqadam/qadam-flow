import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalesEnum } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { invalidateBundledQadamCache, loadBundledQadams } from '../../../../src/app/qadams/metadata/utils'
import { BUNDLED_QADAMS_MANIFEST_FILE, bundledQadamsManifest } from '../../../../src/app/qadams/metadata/utils/bundled-qadams-manifest'
import { fileQadamsUtils } from '../../../../src/app/qadams/metadata/utils/file-qadams-utils'

// `system.get(ENVIRONMENT)` is read into a module-level constant by `qadam-cache.ts` at import
// time, so the mock has to answer before any `beforeEach` runs (see `qadam-cache.test.ts`).
const { getRawMany, systemGet } = vi.hoisted(() => ({
    getRawMany: vi.fn(),
    systemGet: vi.fn((..._args: unknown[]): string | undefined => 'test'),
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        get: (...args: unknown[]) => systemGet(...args),
        getBoolean: (): boolean => false,
    },
}))

// The catalogue merges persisted rows in; with none, `GET /v1/qadams` is the bundled set alone.
vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        createQueryBuilder: () => queryBuilder(),
    }),
}))

const LOAD_COUNTER = '__bundledQadamsManifestTestLoads'
const FIXTURE_QADAMS = ['@fixture/alpha@0.2.0', '@fixture/beta@1.4.1', '@fixture/gamma@0.0.3']
const ALPHA_RU = { 'The alpha fixture': 'Фикстура альфа', 'Send a message': 'Отправить сообщение' }
const PER_LOAD_FIELDS = ['id', 'created', 'updated']
const TRANSLATIONS_ENV = 'AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS'

let repoRoot: string
let qadamsRoot: string
const originalCwd = process.cwd()

describe('bundled qadam metadata manifest (#598)', () => {
    beforeEach(async () => {
        vi.clearAllMocks()
        getRawMany.mockResolvedValue([])
        systemGet.mockImplementation((prop: unknown) => prop === 'DEV_QADAMS' ? undefined : 'test')
        // A fresh tree per test: the scan `require`s the fixtures, and Node caches a module by path.
        repoRoot = await mkdtemp(path.join(tmpdir(), 'bundled-qadams-manifest-'))
        qadamsRoot = path.join(repoRoot, 'packages', 'qadams')
        await writeFixtureQadam({ group: 'core', name: 'alpha', version: '0.2.0' })
        await writeFixtureQadam({ group: 'community', name: 'beta', version: '1.4.1' })
        await writeFixtureQadam({ group: 'community', name: 'gamma', version: '0.0.3' })
        process.chdir(repoRoot)
        process.env[TRANSLATIONS_ENV] = 'true'
        resetLoadCounter()
        invalidateBundledQadamCache()
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        delete process.env[TRANSLATIONS_ENV]
        invalidateBundledQadamCache()
        await rm(repoRoot, { recursive: true, force: true })
    })

    describe('GET /v1/qadams is the same from the manifest as from the scan', () => {
        it.each([LocalesEnum.ENGLISH, LocalesEnum.RUSSIAN])('locale %s', async (locale) => {
            await writeManifestFromScan()
            resetLoadCounter()

            const fromManifest = await listCatalogue({ locale })
            expect(loadedSource()).toBe('manifest')
            // The point of the manifest: not one qadam module was required to answer.
            expect(loadCount()).toBe(0)

            await rm(path.join(qadamsRoot, BUNDLED_QADAMS_MANIFEST_FILE))
            invalidateBundledQadamCache()
            const fromScan = await listCatalogue({ locale })
            expect(loadedSource()).toBe('scan')
            expect(loadCount()).toBe(3)

            // Same qadams, versions and order, then every other field.
            expect(fromManifest.map(nameAndVersion)).toEqual(fromScan.map(nameAndVersion))
            expect(fromManifest.map(nameAndVersion).sort()).toEqual(FIXTURE_QADAMS)
            expect(fromManifest).toEqual(fromScan)
            // Guards against the comparison passing vacuously, with translation never applied.
            const expectedDescription = locale === LocalesEnum.RUSSIAN ? 'Фикстура альфа' : 'The alpha fixture'
            expect(fromManifest.find((qadam) => qadam.name === '@fixture/alpha')?.description).toBe(expectedDescription)
        })
    })

    it('every other caller gets the manifest too: the pinned-version fallback resolves without a require', async () => {
        await writeManifestFromScan()
        resetLoadCounter()

        const resolved = await qadamMetadataService(logger).get({ name: '@fixture/beta', version: '1.4.0', platformId: undefined })

        expect(resolved?.version).toBe('1.4.1')
        expect(loadedSource()).toBe('manifest')
        expect(loadCount()).toBe(0)
    })

    it('scans quietly when there is no manifest (the dev tree)', async () => {
        const qadams = await loadBundledQadams(logger)

        expect(qadams.map(nameAndVersion).sort()).toEqual(FIXTURE_QADAMS)
        expect(loadedSource()).toBe('scan')
        expect(logger.warn).not.toHaveBeenCalled()
    })

    it('keeps scanning only the AP_DEV_QADAMS set, even with a manifest present', async () => {
        await writeManifestFromScan()
        systemGet.mockImplementation((prop: unknown) => prop === 'DEV_QADAMS' ? 'beta' : 'test')
        resetLoadCounter()

        const qadams = await loadBundledQadams(logger)

        expect(qadams.map(nameAndVersion)).toEqual(['@fixture/beta@1.4.1'])
        expect(loadedSource()).toBe('dev-qadams-scan')
        expect(loadCount()).toBe(1)
    })

    it.each([true, false])('returns i18n only when the scan would (translations flag %s)', async (enabled) => {
        await writeManifestFromScan()
        process.env[TRANSLATIONS_ENV] = String(enabled)

        const fromManifest = await bundledQadamsManifest.read({ qadamsRoot, loadTranslations: enabled, log: logger })
        const fromScan = await fileQadamsUtils(logger).loadAllDistQadamsMetadata({ qadamsRoot, loadTranslations: enabled })

        const alpha = fromManifest?.find((qadam) => qadam.name === '@fixture/alpha')
        expect(alpha?.i18n).toEqual(enabled ? { ru: ALPHA_RU } : undefined)
        expect(fromManifest).toEqual(JSON.parse(JSON.stringify(fromScan)))
    })

    it('writes paths relative to the qadams root and reads them back absolute', async () => {
        await writeManifestFromScan()

        const written = JSON.parse(await readFile(path.join(qadamsRoot, BUNDLED_QADAMS_MANIFEST_FILE), 'utf-8'))
        const read = await bundledQadamsManifest.read({ qadamsRoot, loadTranslations: true, log: logger })

        expect(written.qadams.map((qadam: { directoryPath: string }) => qadam.directoryPath)).toEqual([
            path.join('community', 'beta', 'dist'),
            path.join('community', 'gamma', 'dist'),
            path.join('core', 'alpha', 'dist'),
        ].sort())
        expect(read?.map((qadam) => qadam.directoryPath).sort()).toEqual([
            path.join(qadamsRoot, 'community', 'beta', 'dist'),
            path.join(qadamsRoot, 'community', 'gamma', 'dist'),
            path.join(qadamsRoot, 'core', 'alpha', 'dist'),
        ])
    })

    describe('a bad manifest falls back to the scan and says why', () => {
        it.each<RejectionCase>([
            {
                reason: 'unreadable',
                breakManifest: async (): Promise<void> => {
                    await rm(manifestPath())
                    await mkdir(manifestPath())
                },
            },
            {
                reason: 'not a version-1 manifest',
                label: 'not JSON',
                breakManifest: async (): Promise<unknown> => writeFile(manifestPath(), '{"version":1,"qadams":['),
            },
            {
                reason: 'not a version-1 manifest',
                label: 'another format version',
                breakManifest: async (): Promise<unknown> => rewriteManifest((manifest) => ({ ...manifest, version: 2 })),
            },
            {
                reason: 'not a version-1 manifest',
                label: 'an entry without a name',
                breakManifest: async (): Promise<unknown> => rewriteManifest((manifest) => ({
                    ...manifest,
                    qadams: manifest.qadams.map((qadam, index) => index === 0 ? { ...qadam, name: undefined } : qadam),
                })),
            },
            {
                reason: 'no entries',
                breakManifest: async (): Promise<unknown> => rewriteManifest((manifest) => ({ ...manifest, qadams: [] })),
            },
            {
                reason: 'an entry points outside the qadams root',
                breakManifest: async (): Promise<unknown> => rewriteManifest((manifest) => ({
                    ...manifest,
                    qadams: manifest.qadams.map((qadam, index) => index === 0 ? { ...qadam, directoryPath: path.join('..', '..', 'core', 'alpha', 'dist') } : qadam),
                })),
            },
            {
                reason: 'an entry has no built dist',
                breakManifest: async (): Promise<unknown> => rm(path.join(qadamsRoot, 'community', 'gamma', 'dist', 'package.json')),
            },
            {
                reason: 'an entry does not match its built dist',
                label: 'a dist rebuilt at a new version after the manifest was written',
                breakManifest: async (): Promise<void> => {
                    const distPackageJson = path.join(qadamsRoot, 'community', 'beta', 'dist', 'package.json')
                    await writeFile(distPackageJson, JSON.stringify({ name: '@fixture/beta', version: '1.5.0' }))
                },
            },
        ])('$reason $label', async ({ reason, breakManifest }) => {
            await writeManifestFromScan()
            await breakManifest()
            const expected = await fileQadamsUtils(logger).loadAllDistQadamsMetadata({ qadamsRoot, loadTranslations: true })
            resetLoadCounter()

            const qadams = await loadBundledQadams(logger)

            expect(logger.warn).toHaveBeenCalledWith({ reason }, '[bundledQadamsManifest] manifest rejected, scanning instead')
            expect(loadedSource()).toBe('scan')
            expect(qadams.map(nameAndVersion)).toEqual(expected.map(nameAndVersion))
        })
    })
})

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

function queryBuilder(): ChainableQueryBuilder {
    const builder: ChainableQueryBuilder = {
        select: () => builder,
        addSelect: () => builder,
        getRawMany,
    }
    return builder
}

async function writeFixtureQadam({ group, name, version }: FixtureQadam): Promise<void> {
    const distRoot = path.join(qadamsRoot, group, name, 'dist')
    const packageJson = JSON.stringify({ name: `@fixture/${name}`, version })
    const displayName = name.charAt(0).toUpperCase() + name.slice(1)
    await mkdir(path.join(distRoot, 'src', 'i18n'), { recursive: true })
    await writeFile(path.join(qadamsRoot, group, name, 'package.json'), packageJson)
    await writeFile(path.join(distRoot, 'package.json'), packageJson)
    if (name === 'alpha') {
        await writeFile(path.join(distRoot, 'src', 'i18n', 'ru.json'), JSON.stringify(ALPHA_RU))
    }
    // A stand-in for a built qadam: `extractQadamFromModule` matches on the constructor name, and the
    // live action carries a function, which the manifest cannot hold and the API never serves.
    await writeFile(path.join(distRoot, 'src', 'index.js'), `
globalThis.${LOAD_COUNTER} = (globalThis.${LOAD_COUNTER} ?? 0) + 1
class Qadam {
    constructor() {
        this.authors = ['fixture']
        this._actions = {
            send: { name: 'send', displayName: 'Send a message', description: 'Sends one', props: {}, run: async () => 'sent', requireAuth: false },
        }
    }
    metadata() {
        return {
            displayName: ${JSON.stringify(displayName)},
            logoUrl: 'https://cdn.example/${name}.svg',
            actions: this._actions,
            triggers: {},
            categories: [],
            description: 'The ${name} fixture',
            authors: this.authors,
            auth: undefined,
            minimumSupportedRelease: '0.0.0',
            maximumSupportedRelease: '99999.0.0',
            contextInfo: undefined,
        }
    }
}
exports.qadam = new Qadam()
`)
}

async function writeManifestFromScan(): Promise<void> {
    const utils = fileQadamsUtils(logger)
    const qadams = await utils.loadAllDistQadamsMetadata({ qadamsRoot, loadTranslations: true })
    await bundledQadamsManifest.write({ qadamsRoot, qadams })
    // The writer runs in its own process in the image; dropping its modules here keeps the load
    // counter honest about what the path under test required.
    qadams.forEach((qadam) => utils.clearQadamModuleCache(qadam.directoryPath ?? ''))
}

async function rewriteManifest(change: (manifest: ManifestFile) => unknown): Promise<void> {
    const manifest: ManifestFile = JSON.parse(await readFile(manifestPath(), 'utf-8'))
    await writeFile(manifestPath(), JSON.stringify(change(manifest)))
}

function manifestPath(): string {
    return path.join(qadamsRoot, BUNDLED_QADAMS_MANIFEST_FILE)
}

// What the HTTP layer would send: ids and timestamps are minted per load on both paths, and the
// response is JSON, so a function on a live action is not part of it on either path.
async function listCatalogue({ locale }: { locale: LocalesEnum }): Promise<Record<string, unknown>[]> {
    const qadams = await qadamMetadataService(logger).list({ includeHidden: false, locale })
    const withoutPerLoadFields = qadams.map((qadam) => Object.fromEntries(Object.entries(qadam).filter(([key]) => !PER_LOAD_FIELDS.includes(key))))
    return JSON.parse(JSON.stringify(withoutPerLoadFields))
}

function nameAndVersion(qadam: { name?: unknown, version?: unknown }): string {
    return `${String(qadam.name)}@${String(qadam.version)}`
}

function loadedSource(): unknown {
    const calls = vi.mocked(logger.info).mock.calls
    const line = calls.filter(([, message]) => message === '[loadBundledQadams] Bundled qadam metadata loaded').at(-1)
    const fields: unknown = line?.[0]
    return typeof fields === 'object' && fields !== null && 'source' in fields ? fields.source : undefined
}

function loadCount(): number {
    const count: unknown = Reflect.get(globalThis, LOAD_COUNTER)
    return typeof count === 'number' ? count : 0
}

function resetLoadCounter(): void {
    Reflect.set(globalThis, LOAD_COUNTER, 0)
}

type FixtureQadam = {
    group: string
    name: string
    version: string
}

type ManifestFile = {
    version: number
    qadams: Record<string, unknown>[]
}

type RejectionCase = {
    reason: string
    label?: string
    breakManifest: () => Promise<unknown>
}

type ChainableQueryBuilder = {
    select: () => ChainableQueryBuilder
    addSelect: () => ChainableQueryBuilder
    getRawMany: typeof getRawMany
}

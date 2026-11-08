import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import { PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { storedQadamMetadata } from '../../../../src/app/qadams/metadata/utils/stored-qadam-metadata'

type BundledQadamOverrides = { name: string, version: string }

const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()

vi.mock('../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

vi.mock('../../../../src/app/qadams/metadata/qadam-cache', () => ({
    qadamCache: () => ({
        setup: async () => undefined,
        loadRegistry: (...args: unknown[]) => loadRegistry(...args),
        invalidate: async () => undefined,
    }),
}))

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger
const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const originalStore = process.env[STORE_ENV]
let tempDir: string

beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'qadam-metadata-no-store-'))
    process.env[STORE_ENV] = join(tempDir, 'missing')
})

afterAll(async () => {
    if (originalStore === undefined) {
        delete process.env[STORE_ENV]
    }
    else {
        process.env[STORE_ENV] = originalStore
    }
    await rm(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
    storedQadamMetadata.reset()
})

function bundledQadam({ name, version }: BundledQadamOverrides): QadamMetadataModel {
    return {
        name,
        displayName: name,
        logoUrl: '',
        description: '',
        authors: [],
        version,
        actions: {},
        triggers: {},
        contextInfo: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    }
}

describe('qadamMetadataService.get() — bundled fallback (unit)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([])
    })

    it('falls back to the on-disk bundled version when the pinned version was pruned from the build', async () => {
        loadBundledQadams.mockResolvedValue([
            bundledQadam({ name: '@aiqadam/qadam-fixture', version: '0.4.5' }),
        ])

        const result = await qadamMetadataService(logger).get({
            name: '@aiqadam/qadam-fixture',
            version: '0.4.2',
        })

        expect(result?.version).toBe('0.4.5')
    })

    it('does not cross a major version boundary when falling back', async () => {
        loadBundledQadams.mockResolvedValue([
            bundledQadam({ name: '@aiqadam/qadam-fixture', version: '2.0.0' }),
        ])

        const result = await qadamMetadataService(logger).get({
            name: '@aiqadam/qadam-fixture',
            version: '0.4.2',
        })

        expect(result).toBeUndefined()
    })

    it('does not cross a minor version boundary for a 0.x pin, where semver treats minor as breaking', async () => {
        loadBundledQadams.mockResolvedValue([
            bundledQadam({ name: '@aiqadam/qadam-fixture', version: '0.30.0' }),
        ])

        const result = await qadamMetadataService(logger).get({
            name: '@aiqadam/qadam-fixture',
            version: '0.4.2',
        })

        expect(result).toBeUndefined()
    })

    it('ignores a persisted OFFICIAL registry row that is not actually bundled on disk', async () => {
        loadRegistry.mockResolvedValue([
            {
                name: '@aiqadam/qadam-fixture',
                version: '9.0.0',
                qadamType: QadamType.OFFICIAL,
                platformId: undefined,
            },
        ])
        loadBundledQadams.mockResolvedValue([])

        const result = await qadamMetadataService(logger).get({
            name: '@aiqadam/qadam-fixture',
            version: '0.4.2',
        })

        expect(result).toBeUndefined()
    })

    it('does not fall back onto a differently-named piece', async () => {
        loadBundledQadams.mockResolvedValue([
            bundledQadam({ name: '@aiqadam/qadam-other', version: '0.4.5' }),
        ])

        const result = await qadamMetadataService(logger).get({
            name: '@aiqadam/qadam-fixture',
            version: '0.4.2',
        })

        expect(result).toBeUndefined()
    })
})

// #779, ADR-0004: an exact pin is exact. A snapshot is never published and has no catalogue entry, so
// no other build stands in for it; moving one is #808's checked fallback.
describe('qadamMetadataService.resolveVersion() — exact pins and snapshots (unit)', () => {
    const NAME = '@aiqadam/qadam-fixture'

    function registryEntry({ version }: { version: string }): { name: string, version: string, qadamType: QadamType, platformId: undefined } {
        return { name: NAME, version, qadamType: QadamType.OFFICIAL, platformId: undefined }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([])
    })

    it('resolves an exact snapshot pin to that snapshot', async () => {
        loadRegistry.mockResolvedValue([registryEntry({ version: '1.3.0-main.412' }), registryEntry({ version: '1.3.0-main.500' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '1.3.0-main.412', platformId: undefined })).toBe('1.3.0-main.412')
    })

    it('does not resolve a snapshot pin to a later snapshot of the same base', async () => {
        loadRegistry.mockResolvedValue([registryEntry({ version: '1.3.0-main.500' })])
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: NAME, version: '1.3.0-main.500' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '1.3.0-main.412', platformId: undefined })).toBeUndefined()
    })

    it('does not resolve a snapshot pin to the release of its base or to a later release', async () => {
        loadRegistry.mockResolvedValue([registryEntry({ version: '1.3.0' }), registryEntry({ version: '1.4.0' })])
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: NAME, version: '1.4.0' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '1.3.0-main.412', platformId: undefined })).toBeUndefined()
    })

    it('does not resolve an exact release pin to a snapshot of the next patch', async () => {
        loadRegistry.mockResolvedValue([registryEntry({ version: '1.3.1-main.5' })])
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: NAME, version: '1.3.1-main.5' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '1.3.0', platformId: undefined })).toBeUndefined()
    })

    it('still resolves a stale release pin to the bundled build inside its caret range', async () => {
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: NAME, version: '1.4.2' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '1.2.0', platformId: undefined })).toBe('1.4.2')
    })

    it('still resolves a caret range over snapshots', async () => {
        loadRegistry.mockResolvedValue([registryEntry({ version: '1.3.0-main.500' })])

        expect(await qadamMetadataService(logger).resolveVersion({ name: NAME, version: '^1.3.0-main.412', platformId: undefined })).toBe('1.3.0-main.500')
    })
})

// #808: `get` and `resolveVersion` answer a stale exact pin with the image's build (the run-time net),
// so they cannot say whether the pin itself is there. `isPinAvailable` can, and is what the audited
// move asks.
describe('qadamMetadataService.isPinAvailable() — the pin itself, never a stand-in (unit)', () => {
    const NAME = '@aiqadam/qadam-fixture'

    afterEach(() => {
        vi.restoreAllMocks()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: NAME, version: '0.4.5' })])
    })

    it('is true for a version the registry holds', async () => {
        loadRegistry.mockResolvedValue([{ name: NAME, version: '0.4.2', qadamType: QadamType.OFFICIAL, platformId: undefined }])

        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(true)
    })

    it('is false for a stale pin the net would still run on the bundled build', async () => {
        const service = qadamMetadataService(logger)

        expect(await service.resolveVersion({ name: NAME, version: '0.4.2', platformId: undefined })).toBe('0.4.5')
        expect(await service.isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(false)
    })

    it('is false for a snapshot pin the registry does not hold', async () => {
        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.5-main.9', platformId: undefined })).toBe(false)
    })

    it('does not count another platform\'s row of the same name and version', async () => {
        loadRegistry.mockResolvedValue([{ name: NAME, version: '0.4.2', qadamType: QadamType.CUSTOM, platformId: 'platform-b' }])

        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: 'platform-a' })).toBe(false)
        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: 'platform-b' })).toBe(true)
    })

    it('is true when the version store holds the version, which the engine reads first', async () => {
        const lookup = vi.spyOn(storedQadamMetadata, 'lookup').mockResolvedValue({
            status: 'present',
            stored: { metadata: bundledQadam({ name: NAME, version: '0.4.2' }), frameworkMajor: null },
        })

        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(true)
        expect(lookup).toHaveBeenCalledWith({ name: NAME, version: '0.4.2' })
    })

    it('stays false when the store is absent there, or cannot be opened', async () => {
        // The suite points AP_QADAM_VERSION_STORE_PATH at a directory that does not exist, so this
        // exercises the real open failure rather than a stub.
        const service = qadamMetadataService(logger)
        storedQadamMetadata.reset()

        expect(await service.isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(false)
    })

    it('is false, without asking the registry, for a range or anything that is not a version', async () => {
        const service = qadamMetadataService(logger)

        expect(await service.isPinAvailable({ name: NAME, version: '^0.4.2', platformId: undefined })).toBe(false)
        expect(await service.isPinAvailable({ name: NAME, version: 'latest', platformId: undefined })).toBe(false)
        expect(loadRegistry).not.toHaveBeenCalled()
    })
})

// #879: the two MCP tools resolve every distinct pin of a flow in one batch. The registry used to
// be filtered per pin, which is what made a flow with thousands of agent-tool pins block the API.
describe('qadamMetadataService.getMany() — one registry pass per batch (unit)', () => {
    const pins = Array.from({ length: 25 }, (_, index) => ({
        name: `@aiqadam/qadam-fixture-${index}`,
        version: '1.0.0',
    }))

    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([])
        loadBundledQadams.mockResolvedValue(pins.map((pin) => bundledQadam(pin)))
    })

    it('loads and filters the registry once, keyed by name, for many distinct pins', async () => {
        const result = await qadamMetadataService(logger).getMany({ pins, platformId: undefined })

        expect(loadRegistry).toHaveBeenCalledTimes(1)
        expect(result.size).toBe(pins.length)
        for (const pin of pins) {
            expect(result.get(`${pin.name}@${pin.version}`)).toMatchObject({ status: 'found', metadata: expect.objectContaining({ version: '1.0.0' }) })
        }
    })

    it('asks the registry once even when the same pin is repeated', async () => {
        const result = await qadamMetadataService(logger).getMany({ pins: [pins[0], pins[0], pins[1]], platformId: undefined })

        expect(loadRegistry).toHaveBeenCalledTimes(1)
        expect(result.size).toBe(2)
    })

    it('maps a pin that resolves nowhere to missing', async () => {
        const result = await qadamMetadataService(logger).getMany({
            pins: [{ name: '@aiqadam/qadam-fixture-0', version: '1.0.0' }, { name: '@aiqadam/qadam-missing', version: '1.0.0' }],
            platformId: undefined,
        })

        expect(result.get('@aiqadam/qadam-fixture-0@1.0.0')).toMatchObject({ status: 'found' })
        expect(result.get('@aiqadam/qadam-missing@1.0.0')).toEqual({ status: 'missing' })
    })

    // The tri-state `resolvePins` contract: one pin's failed read must not turn every other pin
    // "unknown", which would stop the heal migration rewriting a definite miss in the same flow.
    it('keeps a failing pin to itself instead of failing the whole batch', async () => {
        const result = await qadamMetadataService(logger).getMany({
            pins: [
                { name: '@aiqadam/qadam-fixture-0', version: '1.0.0' },
                { name: '@aiqadam/qadam-fixture-1', version: 'not-a-version' },
            ],
            platformId: undefined,
        })

        expect(result.get('@aiqadam/qadam-fixture-0@1.0.0')).toMatchObject({ status: 'found' })
        expect(result.get('@aiqadam/qadam-fixture-1@not-a-version')).toEqual({ status: 'error' })
    })
})

// #879: `resolvePins` only needs "does it resolve", so it reads the registry, never one row per
// pin. The tri-state answer stays per pin.
describe('qadamMetadataService.resolveVersions() — registry only (unit)', () => {
    const NAME = '@aiqadam/qadam-fixture'
    const entry = { name: NAME, version: '1.0.0', qadamType: QadamType.OFFICIAL, platformId: undefined }

    beforeEach(() => {
        vi.clearAllMocks()
        loadRegistry.mockResolvedValue([entry])
        loadBundledQadams.mockResolvedValue([])
    })

    it('resolves every pin from one registry pass, without reading a row per pin', async () => {
        const result = await qadamMetadataService(logger).resolveVersions({
            pins: [{ name: NAME, version: '1.0.0' }, { name: NAME, version: '2.0.0' }, { name: NAME, version: '1.0.0' }],
            platformId: undefined,
        })

        expect(loadRegistry).toHaveBeenCalledTimes(1)
        expect(result.get(`${NAME}@1.0.0`)).toEqual({ status: 'resolved', version: '1.0.0' })
        expect(result.get(`${NAME}@2.0.0`)).toEqual({ status: 'missing' })
    })

    it('keeps a failing pin to itself', async () => {
        const result = await qadamMetadataService(logger).resolveVersions({
            pins: [{ name: NAME, version: '1.0.0' }, { name: NAME, version: 'not-a-version' }],
            platformId: undefined,
        })

        expect(result.get(`${NAME}@1.0.0`)).toEqual({ status: 'resolved', version: '1.0.0' })
        expect(result.get(`${NAME}@not-a-version`)).toEqual({ status: 'error' })
    })
})

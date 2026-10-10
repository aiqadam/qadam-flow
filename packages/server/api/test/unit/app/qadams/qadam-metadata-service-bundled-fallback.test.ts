import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import { qadamVersionStoreReader } from '@aiqadam/server-utils'
import { PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'

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
        const read = vi.fn(async () => ({ status: 'present' as const }))
        vi.spyOn(qadamVersionStoreReader, 'open').mockResolvedValue({ ok: true, reader: { read } } as never)

        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(true)
        expect(read).toHaveBeenCalledWith({ coordinates: { platformId: null, name: NAME, version: '0.4.2' } })
    })

    it('stays false when the store is absent there, or cannot be opened', async () => {
        vi.spyOn(qadamVersionStoreReader, 'open').mockResolvedValue({ ok: true, reader: { read: async () => ({ status: 'absent' }) } } as never)
        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(false)

        vi.spyOn(qadamVersionStoreReader, 'open').mockRejectedValue(new Error('EACCES'))
        expect(await qadamMetadataService(logger).isPinAvailable({ name: NAME, version: '0.4.2', platformId: undefined })).toBe(false)
    })

    it('is false, without asking the registry, for a range or anything that is not a version', async () => {
        const service = qadamMetadataService(logger)

        expect(await service.isPinAvailable({ name: NAME, version: '^0.4.2', platformId: undefined })).toBe(false)
        expect(await service.isPinAvailable({ name: NAME, version: 'latest', platformId: undefined })).toBe(false)
        expect(loadRegistry).not.toHaveBeenCalled()
    })
})

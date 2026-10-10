import { QadamMetadataModel } from '@aiqadam/qadams-framework'
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

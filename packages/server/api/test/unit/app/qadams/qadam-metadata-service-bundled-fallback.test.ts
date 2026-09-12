import { PackageType, QadamMetadataModel, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'

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

const { qadamMetadataService } = await import('../../../../src/app/qadams/metadata/qadam-metadata-service')

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

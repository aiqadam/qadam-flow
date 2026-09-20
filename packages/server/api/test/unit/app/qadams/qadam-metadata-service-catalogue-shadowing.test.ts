import { PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'

// `vi.hoisted` for the same reason as `qadam-cache.test.ts`: `vi.mock` factories are hoisted
// above a plain `const`, and this module graph reads `system.get(ENVIRONMENT)` at import time
// (inside `qadam-cache.ts`, transitively imported by `qadam-metadata-service.ts`).
const { getRawMany, find, loadBundledQadams, systemGetBoolean } = vi.hoisted(() => ({
    getRawMany: vi.fn(),
    find: vi.fn(),
    loadBundledQadams: vi.fn(),
    systemGetBoolean: vi.fn((..._args: unknown[]): boolean | undefined => undefined),
}))

// `isTestingEnvironment` in `qadam-cache.ts` is irrelevant here — this test never calls
// `qadamCache`'s `setup`/`loadRegistry`/`invalidate`, only `isOfficialQadamsInstallEnabled()`,
// which reads `system.getBoolean` directly — so `system.get` can return anything.
vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        get: (): undefined => undefined,
        getBoolean: (...args: unknown[]) => systemGetBoolean(...args),
    },
}))

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        createQueryBuilder: () => queryBuilder(),
        find,
    }),
}))

vi.mock('../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

function queryBuilder(): ChainableQueryBuilder {
    const builder: ChainableQueryBuilder = {
        select: () => builder,
        addSelect: () => builder,
        getRawMany,
    }
    return builder
}

function bundledQadam({ name, version }: { name: string, version: string }): QadamRow {
    return qadamRow({ name, version, qadamType: QadamType.OFFICIAL, platformId: undefined })
}

function qadamRow({ name, version, qadamType, platformId }: {
    name: string
    version: string
    qadamType: QadamType
    platformId?: string
}): QadamRow {
    return {
        id: `${name}@${version}`,
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
        qadamType,
        packageType: PackageType.REGISTRY,
        platformId,
        minimumSupportedRelease: '0.0.0',
        maximumSupportedRelease: '9999.9999.9999',
        created: new Date(0).toISOString(),
        updated: new Date(0).toISOString(),
    }
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

// Same finding as `qadam-cache.test.ts`, at the sibling site: `fetchLatestQadams` (the catalogue
// behind `GET /v1/qadams`, i.e. `qadamMetadataService.list()`) used to shadow a persisted row by a
// bundled qadam's name alone, independently of `qadamCache.loadRegistry()`. A lookalike row was
// therefore hidden from this catalogue while remaining resolvable — and executable — through
// `get()`/`registry()`. Both must now agree, keyed by the same `shadowKey`/
// `isOfficialQadamsInstallEnabled` `qadam-cache.ts` exports.
describe('qadamMetadataService.list() — catalogue shadowing agrees with qadamCache.loadRegistry()', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        systemGetBoolean.mockReturnValue(false)
        loadBundledQadams.mockResolvedValue([])
        getRawMany.mockResolvedValue([])
        find.mockResolvedValue([])
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED off (default): a persisted row sharing a bundled name is absent from the catalogue', async () => {
        const bundled = bundledQadam({ name: '@aiqadam/qadam-tables', version: '0.4.5' })
        const persisted = qadamRow({ name: '@aiqadam/qadam-tables', version: '999.0.0', qadamType: QadamType.OFFICIAL, platformId: undefined })
        loadBundledQadams.mockResolvedValue([bundled])
        getRawMany.mockResolvedValue([persisted])
        find.mockResolvedValue([persisted])

        const list = await qadamMetadataService(logger).list({ includeHidden: true })

        const matching = list.filter((entry) => entry.name === '@aiqadam/qadam-tables')
        expect(matching).toHaveLength(1)
        expect(matching[0].version).toBe('0.4.5')
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED on: a persisted row at a different version than the bundled one is visible in the catalogue', async () => {
        systemGetBoolean.mockReturnValue(true)
        const bundled = bundledQadam({ name: '@aiqadam/qadam-tables', version: '0.4.5' })
        const persisted = qadamRow({ name: '@aiqadam/qadam-tables', version: '999.0.0', qadamType: QadamType.OFFICIAL, platformId: undefined })
        loadBundledQadams.mockResolvedValue([bundled])
        getRawMany.mockResolvedValue([persisted])
        find.mockResolvedValue([persisted])

        const list = await qadamMetadataService(logger).list({ includeHidden: true })

        // `lastVersionOfEachQadam` keeps the single highest version per name — the persisted row
        // is given a version above the bundled one specifically so its presence is observable
        // through this "one row per name" catalogue rather than losing a version comparison this
        // test does not exist to make.
        const matching = list.filter((entry) => entry.name === '@aiqadam/qadam-tables')
        expect(matching).toHaveLength(1)
        expect(matching[0].version).toBe('999.0.0')
    })
})

type ChainableQueryBuilder = {
    select: () => ChainableQueryBuilder
    addSelect: () => ChainableQueryBuilder
    getRawMany: () => unknown
}

type QadamRow = {
    id: string
    name: string
    displayName: string
    logoUrl: string
    description: string
    authors: string[]
    version: string
    actions: Record<string, never>
    triggers: Record<string, never>
    contextInfo: undefined
    projectUsage: number
    qadamType: QadamType
    packageType: PackageType
    platformId: string | undefined
    minimumSupportedRelease: string
    maximumSupportedRelease: string
    created: string
    updated: string
}

import { LocalesEnum, PackageType, QadamType, SuggestionType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { fileQadamsUtils } from '../../../../src/app/qadams/metadata/utils/file-qadams-utils'

// Same mock harness as `qadam-metadata-service-catalogue-shadowing.test.ts`: `list()` is the
// catalogue behind `GET /v1/qadams`, and the bundled side is the shared per-process cache.
const { getRawMany, find, loadBundledQadams, systemGetBoolean } = vi.hoisted(() => ({
    getRawMany: vi.fn(),
    find: vi.fn(),
    loadBundledQadams: vi.fn(),
    systemGetBoolean: vi.fn((..._args: unknown[]): boolean | undefined => undefined),
}))

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

const EN_DESCRIPTION = 'Run on a schedule'
const RU_DESCRIPTION = 'Запуск по расписанию'
const EN_ACTION_DISPLAY_NAME = 'Every hour'
const RU_ACTION_DISPLAY_NAME = 'Каждый час'
const TRANSLATIONS_ENV = 'AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS'

function bundledQadam(): QadamRow {
    return {
        id: '@aiqadam/qadam-schedule@0.1.17',
        name: '@aiqadam/qadam-schedule',
        displayName: 'Schedule',
        logoUrl: '',
        description: EN_DESCRIPTION,
        authors: [],
        version: '0.1.17',
        actions: {
            run_every: {
                displayName: EN_ACTION_DISPLAY_NAME,
            },
        },
        triggers: {},
        contextInfo: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
        platformId: undefined,
        minimumSupportedRelease: '0.0.0',
        maximumSupportedRelease: '9999.9999.9999',
        created: new Date(0).toISOString(),
        updated: new Date(0).toISOString(),
        i18n: {
            [LocalesEnum.RUSSIAN]: {
                [EN_DESCRIPTION]: RU_DESCRIPTION,
                [EN_ACTION_DISPLAY_NAME]: RU_ACTION_DISPLAY_NAME,
            },
        },
    }
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

// #606: `fetchLatestQadams` translated the cached bundled qadams in place (`mutate: true`), so a
// `?locale=ru` request left Russian strings in the shared cache and later `en` requests served
// them. Translation must copy, so `ru` followed by `en` returns English.
describe('qadamMetadataService.list() — translating bundled qadams does not mutate the cache', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        systemGetBoolean.mockReturnValue(false)
        getRawMany.mockResolvedValue([])
        find.mockResolvedValue([])
    })

    it('a ru request followed by an en request returns English', async () => {
        const bundled = bundledQadam()
        // The same object across calls, the way the per-process `loadBundledQadams` cache behaves.
        loadBundledQadams.mockResolvedValue([bundled])

        const ru = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.RUSSIAN })
        expect(ru.find((entry) => entry.name === bundled.name)?.description).toBe(RU_DESCRIPTION)

        const en = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.ENGLISH })
        expect(en.find((entry) => entry.name === bundled.name)?.description).toBe(EN_DESCRIPTION)

        expect(bundled.description).toBe(EN_DESCRIPTION)
    })

    it('nested action strings are translated per request without leaking across locales', async () => {
        const bundled = bundledQadam()
        loadBundledQadams.mockResolvedValue([bundled])

        const ru = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.RUSSIAN, suggestionType: SuggestionType.ACTION })
        const ruAction = ru.find((entry) => entry.name === bundled.name)?.suggestedActions?.[0] as { displayName?: string } | undefined
        expect(ruAction?.displayName).toBe(RU_ACTION_DISPLAY_NAME)

        const en = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.ENGLISH, suggestionType: SuggestionType.ACTION })
        const enAction = en.find((entry) => entry.name === bundled.name)?.suggestedActions?.[0] as { displayName?: string } | undefined
        expect(enAction?.displayName).toBe(EN_ACTION_DISPLAY_NAME)
    })

    it('a locale the qadam has no catalogue for leaves the cached i18n intact', async () => {
        const bundled = bundledQadam()
        loadBundledQadams.mockResolvedValue([bundled])

        const uz = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.UZBEK })
        expect(uz.find((entry) => entry.name === bundled.name)?.description).toBe(EN_DESCRIPTION)

        const ru = await qadamMetadataService(logger).list({ includeHidden: true, locale: LocalesEnum.RUSSIAN })
        expect(ru.find((entry) => entry.name === bundled.name)?.description).toBe(RU_DESCRIPTION)
        expect(bundled.i18n).toBeDefined()
    })
})

// #606: translations must load unless explicitly opted out — with the gate off, `?locale=ru`
// has no catalogues to apply even when the dists carry them. The gate reads raw `process.env`
// (`environmentVariables`), never the `system.ts` defaults, so the effective default lives here.
describe('bundled qadam translation loading', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('loads translations when the flag is unset', () => {
        delete process.env[TRANSLATIONS_ENV]

        expect(fileQadamsUtils(logger).isTranslationLoadingEnabled()).toBe(true)
    })

    it.each(['true', 'false'])('honours an explicit flag value (%s)', (flag) => {
        vi.stubEnv(TRANSLATIONS_ENV, flag)

        expect(fileQadamsUtils(logger).isTranslationLoadingEnabled()).toBe(flag === 'true')
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
    actions: Record<string, { displayName: string }>
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
    i18n: Record<string, Record<string, string>>
}

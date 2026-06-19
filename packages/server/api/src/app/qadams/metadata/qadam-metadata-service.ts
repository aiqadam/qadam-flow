import { QadamMetadata, QadamMetadataModel, QadamMetadataModelSummary, QadamPackageInformation, qadamTranslation } from '@aiqadam/qadams-framework'
import { apVersionUtil } from '@aiqadam/server-utils'
import {
    apId,
    assertNotNullOrUndefined,
    ErrorCode,
    EXACT_VERSION_REGEX,
    isNil,
    LocalesEnum,
    PackageType,
    PlatformId,
    PrivateQadamPackage,
    PublicQadamPackage,
    QadamCategory,
    QadamFlowError,
    QadamOrderBy,
    QadamPackage,
    QadamSortBy,
    QadamType,
    SuggestionType,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import semVer from 'semver'
import { EntityManager, In, IsNull } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { qadamTagService } from '../tags/qadams/qadam-tag.service'
import { qadamCache, QadamRegistryEntry } from './qadam-cache'
import { QadamMetadataEntity, QadamMetadataSchema } from './qadam-metadata-entity'
import { filterQadamBasedOnType, isNewerVersion, isSupportedRelease, lastVersionOfEachQadam, loadBundledQadams, qadamListUtils } from './utils'

export const qadamRepos = repoFactory(QadamMetadataEntity)

export const qadamMetadataService = (log: FastifyBaseLogger) => {
    return {
        async setup(): Promise<void> {
            await qadamCache(log).setup()
        },
        async list(params: ListParams): Promise<QadamMetadataModelSummary[]> {
            const locale = params.locale ?? LocalesEnum.ENGLISH
            const translatedQadams = await dedupe(`list:${params.platformId ?? ''}:${locale}`, () => fetchLatestQadams({
                platformId: params.platformId,
                locale,
                log,
            }))
            const qadamsWithTags = await enrichTags(params.platformId, translatedQadams, params.includeTags)
            const filteredQadams = await qadamListUtils(log).filterPieces({
                ...params,
                pieces: qadamsWithTags,
                suggestionType: params.suggestionType,
            })

            return toQadamMetadataModelSummary(filteredQadams, translatedQadams, params.suggestionType)
        },
        async registry(params: RegistryParams): Promise<QadamPackageInformation[]> {
            const registry = filterRegistry(await loadRegistry(log), {
                release: params.release,
                platformId: params.platformId,
            })
            return registry.map((qadam) => ({
                name: qadam.name,
                version: qadam.version,
            }))
        },
        async get({ projectId: _projectId, platformId, version, name }: GetOrThrowParams): Promise<QadamMetadataModel | undefined> {
            const bestMatch = await findExactVersion(log, { name, version, platformId })
            if (isNil(bestMatch)) {
                return undefined
            }
            const qadam = await dedupe(`qadam:${bestMatch.name}:${bestMatch.version}:${bestMatch.platformId ?? ''}`, () => fetchQadamVersion({
                qadamName: bestMatch.name,
                version: bestMatch.version,
                platformId: bestMatch.platformId,
                log,
            }))

            if (isNil(qadam)) {
                return undefined
            }
            return qadam
        },
        async getOrThrow({ version, name, platformId, locale }: GetOrThrowParams): Promise<QadamMetadataModel> {
            const qadam = await this.get({ version, name, platformId })
            if (isNil(qadam)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        message: `qadam_metadata_not_found qadamName=${name}`,
                    },
                })
            }
            if (isNil(locale) || locale === LocalesEnum.ENGLISH) {
                return qadam
            }
            return qadamTranslation.translatePiece<QadamMetadataModel>({ piece: qadam, locale, mutate: false })
        },
        async updateUsage({ id, usage }: UpdateUsage): Promise<void> {
            const existingMetadata = await qadamRepos().findOneByOrFail({
                id,
            })
            await qadamRepos().update(id, {
                projectUsage: usage,
                updated: existingMetadata.updated,
                created: existingMetadata.created,
            })
        },
        async resolveExactVersion({ name, version, platformId }: GetExactPieceVersionParams): Promise<string> {
            const isExactVersion = EXACT_VERSION_REGEX.test(version)

            if (isExactVersion) {
                return version
            }

            const qadamMetadata = await this.getOrThrow({
                name,
                version,
                platformId,
            })

            return qadamMetadata.version
        },
        async create({
            qadamMetadata,
            platformId,
            packageType,
            qadamType,
            archiveId,
            publishCacheRefresh = true,
        }: CreateParams): Promise<QadamMetadataSchema> {
            const existingMetadata = await qadamRepos().findOneBy({
                name: qadamMetadata.name,
                version: qadamMetadata.version,
                platformId: platformId ?? IsNull(),
            })
            if (!isNil(existingMetadata)) {
                throw new QadamFlowError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: `qadam_metadata_already_exists name=${qadamMetadata.name} version=${qadamMetadata.version}`,
                    },
                })
            }
            const createdDate = await findOldestCreatedDate({
                name: qadamMetadata.name,
                platformId,
            })
            const savedQadam = await qadamRepos().save({
                id: apId(),
                packageType,
                qadamType,
                archiveId,
                platformId,
                created: createdDate,
                ...qadamMetadata,
            })
            if (publishCacheRefresh) {
                await qadamCache(log).invalidate()
            }
            return savedQadam
        },

        async bulkDelete(pieces: { name: string, version: string }[]): Promise<void> {
            const results = await Promise.all(pieces.map((qadam) =>
                qadamRepos().delete({ name: qadam.name, version: qadam.version }),
            ))
            const anyDeleted = results.some((result) => !isNil(result.affected) && result.affected > 0)
            if (anyDeleted) {
                await qadamCache(log).invalidate()
            }
        },
    }
}

export const getQadamPackageWithoutArchive = async (
    log: FastifyBaseLogger,
    platformId: PlatformId | undefined,
    pkg: Omit<PublicQadamPackage, 'directoryPath' | 'qadamType' | 'packageType'> | Omit<PrivateQadamPackage, 'archiveId' | 'archive' | 'qadamType' | 'packageType'>,
): Promise<QadamPackage> => {
    const qadamMetadata = await qadamMetadataService(log).getOrThrow({
        name: pkg.qadamName,
        version: pkg.qadamVersion,
        platformId,
    })
    switch (qadamMetadata.packageType) {
        case PackageType.ARCHIVE:
            assertNotNullOrUndefined(qadamMetadata.platformId, 'platformId is required')
            return {
                qadamName: qadamMetadata.name,
                qadamVersion: qadamMetadata.version,
                qadamType: qadamMetadata.qadamType,
                packageType: qadamMetadata.packageType,
                archiveId: qadamMetadata.archiveId!,
                platformId: qadamMetadata.platformId,
            }
        case PackageType.REGISTRY: {
            const qadamPlatformId = qadamMetadata.platformId
            if (qadamMetadata.qadamType === QadamType.CUSTOM) {
                assertNotNullOrUndefined(qadamPlatformId, 'platformId is required')
                return {
                    qadamName: qadamMetadata.name,
                    qadamVersion: qadamMetadata.version,
                    packageType: qadamMetadata.packageType,
                    qadamType: qadamMetadata.qadamType,
                    platformId: qadamPlatformId,
                }
            }
            return {
                qadamName: qadamMetadata.name,
                qadamVersion: qadamMetadata.version,
                packageType: qadamMetadata.packageType,
                qadamType: qadamMetadata.qadamType,
            }
        }
    }
}

export function toQadamMetadataModelSummary<T extends QadamMetadataSchema | QadamMetadataModel>(
    qadamMetadataEntityList: T[],
    originalMetadataList: T[],
    suggestionType?: SuggestionType,
): QadamMetadataModelSummary[] {
    return qadamMetadataEntityList.map((qadamMetadataEntity) => {
        const originalMetadata = originalMetadataList.find((p) => p.name === qadamMetadataEntity.name)
        assertNotNullOrUndefined(originalMetadata, `Original metadata not found for ${qadamMetadataEntity.name}`)
        return {
            ...qadamMetadataEntity,
            actions: Object.keys(originalMetadata.actions).length,
            triggers: Object.keys(originalMetadata.triggers).length,
            suggestedActions: suggestionType === SuggestionType.ACTION || suggestionType === SuggestionType.ACTION_AND_TRIGGER ?
                Object.values(qadamMetadataEntity.actions) : undefined,
            suggestedTriggers: suggestionType === SuggestionType.TRIGGER || suggestionType === SuggestionType.ACTION_AND_TRIGGER ?
                Object.values(qadamMetadataEntity.triggers) : undefined,
        }
    })
}

const findOldestCreatedDate = async ({ name, platformId }: { name: string, platformId?: string }): Promise<string> => {
    const qadam = await qadamRepos().findOne({
        where: {
            name,
            platformId: platformId ?? IsNull(),
        },
        order: {
            created: 'ASC',
        },
    })
    return qadam?.created ?? dayjs().toISOString()
}

const enrichTags = async (platformId: string | undefined, qadams: QadamMetadataSchema[], includeTags: boolean | undefined): Promise<QadamMetadataSchema[]> => {
    if (!includeTags || isNil(platformId)) {
        return qadams
    }
    const tags = await qadamTagService.findByPlatform(platformId)
    return qadams.map((qadam) => {
        return {
            ...qadam,
            tags: tags[qadam.name] ?? [],
        }
    })
}

const sortByVersionDescending = <T extends { version: string }>(a: T, b: T): number => {
    const aValid = semVer.valid(a.version)
    const bValid = semVer.valid(b.version)
    if (!aValid && !bValid) {
        return b.version.localeCompare(a.version)
    }
    if (!aValid) {
        return 1
    }
    if (!bValid) {
        return -1
    }
    return semVer.rcompare(a.version, b.version)
}

const findExactVersion = async (
    log: FastifyBaseLogger,
    params: { name: string, version: string | undefined, platformId: string | undefined },
): Promise<{ name: string, version: string, platformId: string | undefined } | undefined> => {
    const { name, version, platformId } = params
    const versionToSearch = findNextExcludedVersion(version)
    const currentRelease = apVersionUtil.getCurrentRelease()
    const registry = filterRegistry(await loadRegistry(log), { release: currentRelease, platformId })
    const matchingRegistryEntries = registry.filter((entry) => {
        if (entry.name !== name) {
            return false
        }
        if (isNil(versionToSearch)) {
            return true
        }
        return semVer.compare(entry.version, versionToSearch.nextExcludedVersion) < 0
            && semVer.compare(entry.version, versionToSearch.baseVersion) >= 0
    })

    if (matchingRegistryEntries.length === 0) {
        return undefined
    }

    const sortedEntries = matchingRegistryEntries.sort(sortByVersionDescending)
    return {
        name: sortedEntries[0].name,
        version: sortedEntries[0].version,
        platformId: sortedEntries[0].platformId,
    }
}

const findNextExcludedVersion = (version: string | undefined): { baseVersion: string, nextExcludedVersion: string } | undefined => {
    if (version?.startsWith('^')) {
        const baseVersion = version.substring(1)
        return {
            baseVersion,
            nextExcludedVersion: increaseMajorVersion(baseVersion),
        }
    }
    if (version?.startsWith('~')) {
        const baseVersion = version.substring(1)
        return {
            baseVersion,
            nextExcludedVersion: increaseMinorVersion(baseVersion),
        }
    }
    if (isNil(version)) {
        return undefined
    }
    return {
        baseVersion: version,
        nextExcludedVersion: increasePatchVersion(version),
    }
}

const increasePatchVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'patch')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase patch version ${version}`)
    }
    return incrementedVersion
}

const increaseMinorVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'minor')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase minor version ${version}`)
    }
    return incrementedVersion
}

const increaseMajorVersion = (version: string): string => {
    const incrementedVersion = semVer.inc(version, 'major')
    if (isNil(incrementedVersion)) {
        throw new Error(`Failed to increase major version ${version}`)
    }
    return incrementedVersion
}

async function fetchLatestQadams({ platformId, locale = LocalesEnum.ENGLISH, log }: FetchLatestQadamsParams): Promise<QadamMetadataSchema[]> {
    const currentRelease = apVersionUtil.getCurrentRelease()

    const latestQadams = await dedupe(`latest-qadams:${currentRelease}`, () => fetchLatestCompatiblePiecesFromDB(currentRelease))
    const translatedQadams = translatePieces(latestQadams, locale)

    const bundledQadams = await loadBundledQadams(log)
    const translatedBundled = bundledQadams.map((qadam) =>
        qadamTranslation.translatePiece<QadamMetadataSchema>({ piece: qadam, locale, mutate: true }),
    )

    const bundledNames = new Set(translatedBundled.map((p) => p.name))
    const merged = [...translatedQadams.filter((p) => !bundledNames.has(p.name)), ...translatedBundled]
        .filter((qadam) => filterQadamBasedOnType(platformId, qadam))
        .filter((qadam) => isSupportedRelease(currentRelease, qadam))
    return lastVersionOfEachQadam(merged)
}

async function fetchQadamVersion({ qadamName, version, platformId, log }: FetchQadamVersionParams): Promise<QadamMetadataSchema | null> {
    const bundledQadams = await loadBundledQadams(log)
    const bundled = bundledQadams.find((p) => p.name === qadamName && p.version === version)
    if (!isNil(bundled)) {
        return bundled
    }

    const foundQadam = await qadamRepos().findOne({
        where: {
            name: qadamName,
            version,
            platformId: platformId ?? IsNull(),
        },
    })
    return foundQadam ?? null
}

async function fetchLatestCompatiblePiecesFromDB(currentRelease: string): Promise<QadamMetadataSchema[]> {
    const allKeys = await qadamRepos()
        .createQueryBuilder('pm')
        .select(['pm.id', 'pm.name', 'pm.version', 'pm.platformId', 'pm.minimumSupportedRelease', 'pm.maximumSupportedRelease'])
        .getRawMany<QadamKey>()

    const compatibleKeys = allKeys.filter((qadam) => isSupportedRelease(currentRelease, qadam))
    const latestIds = pickLatestVersionIds(compatibleKeys)
    return latestIds.length > 0 ? qadamRepos().find({ where: { id: In(latestIds) } }) : []
}

function pickLatestVersionIds(qadams: QadamKey[]): string[] {
    const latest = new Map<string, QadamKey>()
    for (const qadam of qadams) {
        const key = `${qadam.name}:${qadam.platformId ?? ''}`
        const existing = latest.get(key)
        if (isNil(existing) || isNewerVersion(qadam.version, existing.version)) {
            latest.set(key, qadam)
        }
    }
    return Array.from(latest.values()).map((p) => p.id)
}

function translatePieces(qadams: QadamMetadataSchema[], locale: LocalesEnum): QadamMetadataSchema[] {
    return qadams.map((qadam) => {
        const translated = locale === LocalesEnum.ENGLISH
            ? { ...qadam }
            : qadamTranslation.translatePiece<QadamMetadataSchema>({ piece: qadam, locale, mutate: false })
        translated.i18n = undefined
        return translated
    })
}

const inflightFetches = new Map<string, Promise<unknown>>()

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflightFetches.get(key) as Promise<T> | undefined
    if (!isNil(existing)) {
        return existing
    }
    const promise = (async () => {
        try {
            return await fn()
        }
        finally {
            inflightFetches.delete(key)
        }
    })()
    inflightFetches.set(key, promise)
    return promise
}

function loadRegistry(log: FastifyBaseLogger): Promise<QadamRegistryEntry[]> {
    return dedupe('registry-load', () => qadamCache(log).loadRegistry())
}

function filterRegistry(registry: QadamRegistryEntry[], params: { release: string | undefined, platformId: string | undefined }): QadamRegistryEntry[] {
    return registry
        .filter((qadam) => filterQadamBasedOnType(params.platformId, qadam))
        .filter((qadam) => isNil(params.release) || isSupportedRelease(params.release, qadam))
}


// Types

type ListParams = {
    projectId?: string
    platformId?: string
    includeHidden: boolean
    categories?: QadamCategory[]
    includeTags?: boolean
    tags?: string[]
    sortBy?: QadamSortBy
    orderBy?: QadamOrderBy
    searchQuery?: string
    suggestionType?: SuggestionType
    locale?: LocalesEnum
}

type GetOrThrowParams = {
    name: string
    version?: string
    entityManager?: EntityManager
    projectId?: string
    platformId?: string
    locale?: LocalesEnum
}

type CreateParams = {
    qadamMetadata: QadamMetadata
    platformId?: string
    projectId?: string
    packageType: PackageType
    qadamType: QadamType
    archiveId?: string
    publishCacheRefresh?: boolean
}

type UpdateUsage = {
    id: string
    usage: number
}

type GetExactPieceVersionParams = {
    name: string
    version: string
    platformId: PlatformId
}

type RegistryParams = {
    release: string
    platformId?: string
}

type FetchLatestQadamsParams = {
    platformId?: string
    locale?: LocalesEnum
    log: FastifyBaseLogger
}

type FetchQadamVersionParams = {
    qadamName: string
    version: string
    platformId?: string
    log: FastifyBaseLogger
}

type QadamKey = {
    id: string
    name: string
    version: string
    platformId: string | null
    minimumSupportedRelease?: string
    maximumSupportedRelease?: string
}


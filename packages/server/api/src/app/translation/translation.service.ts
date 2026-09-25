import {
    ApId,
    apId,
    Cursor,
    ErrorCode,
    isNil,
    localeUtil,
    MAX_TRANSLATION_KEYS_PER_PROJECT,
    QadamFlowError,
    sanitizeObjectForPostgresql,
    SeekPage,
    Translation,
    TRANSLATION_KEY_REGEX,
    TranslationImportFormat,
    TranslationImportMode,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { ILike } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { TranslationEntity, TranslationSchema } from './translation.entity'

export const translationRepo = repoFactory(TranslationEntity)

export const translationService = (log: FastifyBaseLogger) => ({
    async list(params: ListParams): Promise<SeekPage<Translation>> {
        const { projectId, platformId, cursor, limit, key } = params
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)
        const paginator = buildPaginator({
            entity: TranslationEntity,
            query: {
                limit: limit ?? 10,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const queryBuilder = translationRepo()
            .createQueryBuilder('translation')
            .where({
                projectId,
                platformId,
                ...(isNil(key) ? {} : { key: ILike(`%${key}%`) }),
            })
        const { data, cursor: nextCursor } = await paginator.paginate(queryBuilder)
        return paginationHelper.createPage<Translation>(data, nextCursor)
    },

    async listForWorker(params: { projectId: string }): Promise<Translation[]> {
        return translationRepo().findBy({ projectId: params.projectId })
    },

    async getByKeyOrNull(params: { projectId: string, platformId: string, key: string }): Promise<Translation | null> {
        const { projectId, platformId, key } = params
        return translationRepo().findOneBy({ projectId, platformId, key })
    },

    async upsertBatch(params: UpsertBatchParams): Promise<Translation[]> {
        const { projectId, platformId, items } = params
        const canonicalized = items.map((item) => canonicalizeItemLocales(item))

        await assertKeyCapNotExceeded({ projectId, platformId, incomingKeys: canonicalized.map((item) => item.key) })

        for (const item of canonicalized) {
            await upsertMergingValues({ projectId, platformId, key: item.key, values: item.values, description: item.description })
        }
        return translationRepo()
            .createQueryBuilder('translation')
            .where({ projectId, platformId })
            .andWhere('translation.key IN (:...keys)', { keys: canonicalized.map((item) => item.key) })
            .getMany()
    },

    async delete(params: GetOneParams): Promise<Translation> {
        const target = await getOneOrThrow(params)
        await translationRepo().delete({ id: params.id, projectId: params.projectId, platformId: params.platformId })
        log.info({ id: params.id, projectId: params.projectId }, 'Translation deleted')
        return target
    },

    async import(params: ImportParams): Promise<{ importedKeys: number, removedFromLocale: number }> {
        const { projectId, platformId, locale, format, mode, data } = params
        const canonicalLocale = localeUtil.canonicalize(locale)
        if (isNil(canonicalLocale)) {
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${locale}" is not a valid BCP-47 locale tag` } })
        }
        const flattened = format === TranslationImportFormat.NESTED ? flattenNestedData(data) : flattenFlatData(data)
        const keys = Object.keys(flattened)
        await assertKeyCapNotExceeded({ projectId, platformId, incomingKeys: keys })

        for (const key of keys) {
            await upsertMergingValues({
                projectId,
                platformId,
                key,
                values: { [canonicalLocale]: flattened[key] },
                description: undefined,
            })
        }

        let removedFromLocale = 0
        if (mode === TranslationImportMode.REPLACE) {
            removedFromLocale = await removeLocaleFromKeysNotIn({ projectId, platformId, locale: canonicalLocale, keptKeys: keys })
        }
        return { importedKeys: keys.length, removedFromLocale }
    },

    async exportAll(params: { projectId: string, platformId: string, locale: string, format: TranslationImportFormat }): Promise<Record<string, unknown>> {
        const { projectId, platformId, locale, format } = params
        const canonicalLocale = localeUtil.canonicalize(locale)
        if (isNil(canonicalLocale)) {
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${locale}" is not a valid BCP-47 locale tag` } })
        }
        const rows = await translationRepo().findBy({ projectId, platformId })
        const flat = rows.reduce<Record<string, string>>((acc, row) => {
            const value = row.values[canonicalLocale]
            return value === undefined ? acc : { ...acc, [row.key]: value }
        }, {})
        return format === TranslationImportFormat.NESTED ? nestFlatData(flat) : flat
    },
})

async function getOneOrThrow(params: GetOneParams): Promise<Translation> {
    const { id, projectId, platformId } = params
    const row = await translationRepo().findOneBy({ id, projectId, platformId })
    if (isNil(row)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: id, entityType: 'Translation' },
        })
    }
    return row
}

function canonicalizeItemLocales(item: { key: string, values: Record<string, string>, description?: string | null }): { key: string, values: Record<string, string>, description: string | null | undefined } {
    const canonicalValues: Record<string, string> = {}
    for (const [rawLocale, value] of Object.entries(item.values)) {
        const canonical = localeUtil.canonicalize(rawLocale)
        if (isNil(canonical)) {
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${rawLocale}" is not a valid BCP-47 locale tag (key: ${item.key})` } })
        }
        canonicalValues[canonical] = value
    }
    return { key: item.key, values: canonicalValues, description: item.description }
}

// Writes merge via a single `jsonb || jsonb` expression rather than read-modify-write: the row's
// existing `values` are never fetched into the application, so a concurrent writer touching a
// different locale on the same key can never be lost to a stale read.
async function upsertMergingValues(params: { projectId: string, platformId: string, key: string, values: Record<string, string>, description: string | null | undefined }): Promise<void> {
    const { projectId, platformId, key, values, description } = params
    if (!TRANSLATION_KEY_REGEX.test(key)) {
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${key}" is not a valid translation key` } })
    }
    const sanitizedValues = sanitizeObjectForPostgresql(values)
    const id = apId()
    await translationRepo().manager.query(
        `INSERT INTO "translation" ("id", "created", "updated", "projectId", "platformId", "key", "values", "description")
         VALUES ($1, now(), now(), $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT ("projectId", "key") DO UPDATE
         SET "values" = "translation"."values" || EXCLUDED."values",
             "updated" = now(),
             "description" = COALESCE(EXCLUDED."description", "translation"."description")`,
        [id, projectId, platformId, key, JSON.stringify(sanitizedValues), description ?? null],
    )
}

// Rows outside this import's key set that still carry the target locale must lose exactly that
// locale's entry — never the whole row, and never another locale's entry.
//
// `EntityManager#query` on a mutating statement with `RETURNING` resolves to a 2-element tuple,
// `[rows, affectedRowCount]` — not the rows array itself. Reading `.length` off that tuple is
// always `2`, regardless of how many rows actually matched; the row count is `result[1]`, and the
// rows are `result[0]`. This is the one raw-query mutation in this file, so it is the one place
// that tuple shape actually matters.
async function removeLocaleFromKeysNotIn(params: { projectId: string, platformId: string, locale: string, keptKeys: string[] }): Promise<number> {
    const { projectId, platformId, locale, keptKeys } = params
    const excludedKeys = keptKeys.length > 0 ? keptKeys : ['']
    const [, affectedRowCount]: [unknown[], number] = await translationRepo().manager.query(
        `UPDATE "translation"
         SET "values" = "values" - $1, "updated" = now()
         WHERE "projectId" = $2 AND "platformId" = $3 AND "key" <> ALL($4) AND "values" ? $1
         RETURNING "id"`,
        [locale, projectId, platformId, excludedKeys],
    )
    return affectedRowCount
}

async function assertKeyCapNotExceeded(params: { projectId: string, platformId: string, incomingKeys: string[] }): Promise<void> {
    const { projectId, platformId, incomingKeys } = params
    const existing = await translationRepo()
        .createQueryBuilder('translation')
        .select('translation.key', 'key')
        .where({ projectId, platformId })
        .getRawMany<{ key: string }>()
    const existingKeys = new Set(existing.map((row) => row.key))
    const newKeyCount = incomingKeys.filter((key) => !existingKeys.has(key)).length
    if (existingKeys.size + newKeyCount > MAX_TRANSLATION_KEYS_PER_PROJECT) {
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: { resource: 'translation_keys', limit: MAX_TRANSLATION_KEYS_PER_PROJECT },
        })
    }
}

function flattenFlatData(data: Record<string, unknown>): Record<string, string> {
    return Object.entries(data).reduce<Record<string, string>>((acc, [key, value]) => {
        // A computed key in an object literal is `[[DefineOwnProperty]]`, never `[[Set]]` — a key
        // literally named `__proto__` lands as an ordinary own property instead of tripping
        // `Object.prototype`'s `__proto__` accessor, which bracket assignment (`acc[key] = value`)
        // would.
        return typeof value === 'string' ? { ...acc, [key]: value } : acc
    }, {})
}

function flattenNestedData(data: Record<string, unknown>): Record<string, string> {
    return flattenNestedRecursive({ node: data, prefix: [] })
}

function flattenNestedRecursive(params: { node: unknown, prefix: string[] }): Record<string, string> {
    const { node, prefix } = params
    if (typeof node === 'string') {
        return prefix.length === 0 ? {} : { [prefix.join('.')]: node }
    }
    if (typeof node !== 'object' || isNil(node) || Array.isArray(node)) {
        return {}
    }
    return Object.entries(node).reduce<Record<string, string>>((acc, [segment, value]) => {
        return { ...acc, ...flattenNestedRecursive({ node: value, prefix: [...prefix, segment] }) }
    }, {})
}

type NestedNode = { [key: string]: string | NestedNode }

function isNestedNode(value: string | NestedNode | undefined): value is NestedNode {
    return typeof value === 'object' && value !== null
}

// `Object.defineProperty` throughout, not bracket assignment (`cursor[segment] = ...`): the latter
// is `[[Set]]`, which for a segment literally named `__proto__` walks up to
// `Object.prototype`'s `__proto__` accessor instead of creating an own property on `cursor`.
function setOwnProperty(target: NestedNode, key: string, value: string | NestedNode): void {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

function getOwnProperty(target: NestedNode, key: string): string | NestedNode | undefined {
    return Object.getOwnPropertyDescriptor(target, key)?.value
}

function nestFlatData(flat: Record<string, string>): NestedNode {
    const root: NestedNode = {}
    for (const [key, value] of Object.entries(flat)) {
        const segments = key.split('.')
        let cursor = root
        segments.forEach((segment, index) => {
            if (index === segments.length - 1) {
                setOwnProperty(cursor, segment, value)
                return
            }
            const existing = getOwnProperty(cursor, segment)
            const next = isNestedNode(existing) ? existing : {}
            setOwnProperty(cursor, segment, next)
            cursor = next
        })
    }
    return root
}

type ListParams = {
    projectId: string
    platformId: string
    cursor: Cursor | undefined
    limit: number | undefined
    key: string | undefined
}

type GetOneParams = {
    id: ApId
    projectId: string
    platformId: string
}

type UpsertBatchParams = {
    projectId: string
    platformId: string
    items: { key: string, values: Record<string, string>, description?: string | null }[]
}

type ImportParams = {
    projectId: string
    platformId: string
    locale: string
    format: TranslationImportFormat
    mode: TranslationImportMode
    data: Record<string, unknown>
}

export type { TranslationSchema }

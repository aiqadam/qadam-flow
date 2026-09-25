import {
    ApId,
    apId,
    Cursor,
    ErrorCode,
    isNil,
    localeUtil,
    MAX_TRANSLATION_KEYS_PER_PROJECT,
    MAX_TRANSLATION_LOCALES_PER_KEY,
    MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT,
    QadamFlowError,
    sanitizeObjectForPostgresql,
    SeekPage,
    Translation,
    TRANSLATION_DESCRIPTION_MAX_LENGTH,
    TRANSLATION_KEY_MAX_LENGTH,
    TRANSLATION_KEY_REGEX,
    TranslationImportFormat,
    TranslationImportMode,
    TRANSLATION_VALUE_MAX_LENGTH,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, ILike } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { transaction } from '../core/db/transaction'
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
        // Validated up front, against the whole payload, before a single row is touched — a
        // malformed item later in the batch must not leave earlier items in the batch written.
        canonicalized.forEach((item) => assertItemIsWellFormed(item))

        return transaction(async (entityManager) => {
            await acquireProjectTranslationWriteLock({ entityManager, projectId })
            await assertKeyCapNotExceeded({ entityManager, projectId, platformId, incomingKeys: canonicalized.map((item) => item.key) })

            for (const item of canonicalized) {
                await upsertMergingValues({ entityManager, projectId, platformId, key: item.key, values: item.values, description: item.description })
            }
            await assertTableByteCapNotExceeded({ entityManager, projectId, platformId })

            return translationRepo(entityManager)
                .createQueryBuilder('translation')
                .where({ projectId, platformId })
                .andWhere('translation.key IN (:...keys)', { keys: canonicalized.map((item) => item.key) })
                .getMany()
        })
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
        // Validated up front, against the whole flattened payload, before a single row is
        // touched — the key-count cap already aborted mid-flatten above if the payload alone
        // could never fit; this additionally rejects a well-counted but malformed key/value.
        for (const key of keys) {
            assertKeyIsWellFormed(key)
            assertValuesAreWellFormed({ [canonicalLocale]: flattened[key] })
        }

        return transaction(async (entityManager) => {
            await acquireProjectTranslationWriteLock({ entityManager, projectId })
            await assertKeyCapNotExceeded({ entityManager, projectId, platformId, incomingKeys: keys })

            for (const key of keys) {
                await upsertMergingValues({
                    entityManager,
                    projectId,
                    platformId,
                    key,
                    values: { [canonicalLocale]: flattened[key] },
                    description: undefined,
                })
            }

            let removedFromLocale = 0
            if (mode === TranslationImportMode.REPLACE) {
                removedFromLocale = await removeLocaleFromKeysNotIn({ entityManager, projectId, platformId, locale: canonicalLocale, keptKeys: keys })
            }
            await assertTableByteCapNotExceeded({ entityManager, projectId, platformId })
            return { importedKeys: keys.length, removedFromLocale }
        })
    },

    async exportAll(params: { projectId: string, platformId: string, locale: string, format: TranslationImportFormat }): Promise<Record<string, unknown>> {
        const { projectId, platformId, locale, format } = params
        const canonicalLocale = localeUtil.canonicalize(locale)
        if (isNil(canonicalLocale)) {
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${locale}" is not a valid BCP-47 locale tag` } })
        }
        const rows = await translationRepo().findBy({ projectId, platformId })
        // Local mutation via `Object.defineProperty`, not `{ ...acc, [row.key]: value }`: the
        // latter re-copies the whole accumulator on every row, which is quadratic against a
        // project's whole key count (up to `MAX_TRANSLATION_KEYS_PER_PROJECT`).
        const flat: Record<string, string> = {}
        for (const row of rows) {
            const value = row.values[canonicalLocale]
            if (value !== undefined) {
                Object.defineProperty(flat, row.key, { value, writable: true, enumerable: true, configurable: true })
            }
        }
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

function assertItemIsWellFormed(item: { key: string, values: Record<string, string>, description?: string | null }): void {
    assertKeyIsWellFormed(item.key)
    assertValuesAreWellFormed(item.values)
    assertDescriptionIsWellFormed(item.description)
}

function assertKeyIsWellFormed(key: string): void {
    if (key.length > TRANSLATION_KEY_MAX_LENGTH || !TRANSLATION_KEY_REGEX.test(key)) {
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `"${key}" is not a valid translation key` } })
    }
}

function assertValuesAreWellFormed(values: Record<string, string>): void {
    if (Object.keys(values).length > MAX_TRANSLATION_LOCALES_PER_KEY) {
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: { resource: 'translation_locales_per_key', limit: MAX_TRANSLATION_LOCALES_PER_KEY },
        })
    }
    for (const value of Object.values(values)) {
        if (value.length > TRANSLATION_VALUE_MAX_LENGTH) {
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `Translation value is too long (max ${TRANSLATION_VALUE_MAX_LENGTH} characters)` } })
        }
    }
}

function assertDescriptionIsWellFormed(description: string | null | undefined): void {
    if (!isNil(description) && description.length > TRANSLATION_DESCRIPTION_MAX_LENGTH) {
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message: `Description is too long (max ${TRANSLATION_DESCRIPTION_MAX_LENGTH} characters)` } })
    }
}

// One lock per project, held for the rest of the enclosing transaction (`pg_advisory_xact_lock`,
// released automatically on commit/rollback — never explicitly unlocked). Without it, two
// concurrent writers can each pass their own `assertKeyCapNotExceeded`/
// `assertTableByteCapNotExceeded` read against a snapshot that is stale by the time either one's
// writes land, letting the project's true key count or byte total exceed both caps. Salted with a
// literal string distinct from every other feature's advisory-lock namespace in this codebase
// (e.g. `table.service.ts`'s table-key lock) so the two can never collide on the same lock id.
async function acquireProjectTranslationWriteLock(params: { entityManager: EntityManager, projectId: string }): Promise<void> {
    const { entityManager, projectId } = params
    await entityManager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`translation-write:${projectId}`])
}

// Writes merge via a single `jsonb || jsonb` expression rather than read-modify-write: the row's
// existing `values` are never fetched into the application, so a concurrent writer touching a
// different locale on the same key can never be lost to a stale read.
//
// Re-validates key/values/description here too, even though every route into this function
// already validates its own input (the REST DTO's zod schema, the MCP tools' own schemas, and
// `import`'s pre-flattening checks above) — this is the one function every write path funnels
// through, so it is the one place a future caller cannot bypass the caps by construction.
async function upsertMergingValues(params: { entityManager: EntityManager, projectId: string, platformId: string, key: string, values: Record<string, string>, description: string | null | undefined }): Promise<void> {
    const { entityManager, projectId, platformId, key, values, description } = params
    assertKeyIsWellFormed(key)
    assertValuesAreWellFormed(values)
    assertDescriptionIsWellFormed(description)
    const sanitizedValues = sanitizeObjectForPostgresql(values)
    const id = apId()
    await entityManager.query(
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
async function removeLocaleFromKeysNotIn(params: { entityManager: EntityManager, projectId: string, platformId: string, locale: string, keptKeys: string[] }): Promise<number> {
    const { entityManager, projectId, platformId, locale, keptKeys } = params
    const excludedKeys = keptKeys.length > 0 ? keptKeys : ['']
    const [, affectedRowCount]: [unknown[], number] = await entityManager.query(
        `UPDATE "translation"
         SET "values" = "values" - $1, "updated" = now()
         WHERE "projectId" = $2 AND "platformId" = $3 AND "key" <> ALL($4) AND "values" ? $1
         RETURNING "id"`,
        [locale, projectId, platformId, excludedKeys],
    )
    return affectedRowCount
}

async function assertKeyCapNotExceeded(params: { entityManager: EntityManager, projectId: string, platformId: string, incomingKeys: string[] }): Promise<void> {
    const { entityManager, projectId, platformId, incomingKeys } = params
    const existing = await translationRepo(entityManager)
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

// Checked after this write's own inserts/updates/removals, inside the same transaction and behind
// the same advisory lock as the key-count cap — so a build-up of many large values cannot slip
// past the per-key/per-value caps by spreading itself across more keys than any single request
// touches. `octet_length` on the jsonb column's own text form is a reasonable proxy for what the
// row actually costs to store; it need not match Postgres's internal TOAST accounting exactly to
// serve as a hard, if approximate, backstop.
async function assertTableByteCapNotExceeded(params: { entityManager: EntityManager, projectId: string, platformId: string }): Promise<void> {
    const { entityManager, projectId, platformId } = params
    const [{ totalBytes }]: [{ totalBytes: string }] = await entityManager.query(
        `SELECT COALESCE(SUM(octet_length("values"::text)), 0) AS "totalBytes"
         FROM "translation"
         WHERE "projectId" = $1 AND "platformId" = $2`,
        [projectId, platformId],
    )
    if (Number(totalBytes) > MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT) {
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: { resource: 'translation_table_bytes', limit: MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT },
        })
    }
}

// Builds the flat result by local mutation (`Object.defineProperty` on one object owned entirely
// by this function, never handed to the caller before it is complete) rather than the previous
// `{ ...acc, [key]: value }` spread-per-entry, which re-copies everything accumulated so far on
// EVERY entry — O(n^2) on the number of keys in the payload. Measured: 5k keys took ~6s, and 20k
// did not finish inside a 290s bound. `Object.defineProperty`, not bracket assignment
// (`result[key] = value`), for the same reason as the original code: a computed key in an object
// literal is `[[DefineOwnProperty]]`, but bracket assignment is `[[Set]]`, which for a key
// literally named `__proto__` walks up to `Object.prototype`'s accessor instead of creating an
// ordinary own property.
//
// Aborts as soon as the running count passes the per-project cap, rather than flattening the
// whole payload first and only then comparing against the cap — a 50k-key single-locale import
// stops at key 5,001 instead of materializing all 50k.
function flattenFlatData(data: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {}
    let count = 0
    for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'string') {
            continue
        }
        count += 1
        assertFlattenedKeyCountWithinCap(count)
        Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true })
    }
    return result
}

function flattenNestedData(data: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {}
    const counter = { value: 0 }
    flattenNestedInto({ node: data, prefix: [], result, counter })
    return result
}

// Mutates the SAME `result` object across the whole recursive walk, instead of returning a fresh
// object per call and merging results back up — the latter still re-copies every key already
// found in a subtree once per ancestor level, which is quadratic again for a sufficiently wide
// tree even though each individual merge uses `Object.defineProperty`. One `defineProperty` call
// per leaf string value, total, regardless of nesting shape.
function flattenNestedInto(params: { node: unknown, prefix: string[], result: Record<string, string>, counter: { value: number } }): void {
    const { node, prefix, result, counter } = params
    if (typeof node === 'string') {
        if (prefix.length === 0) {
            return
        }
        counter.value += 1
        assertFlattenedKeyCountWithinCap(counter.value)
        Object.defineProperty(result, prefix.join('.'), { value: node, writable: true, enumerable: true, configurable: true })
        return
    }
    if (typeof node !== 'object' || isNil(node) || Array.isArray(node)) {
        return
    }
    for (const [segment, value] of Object.entries(node)) {
        flattenNestedInto({ node: value, prefix: [...prefix, segment], result, counter })
    }
}

function assertFlattenedKeyCountWithinCap(count: number): void {
    if (count > MAX_TRANSLATION_KEYS_PER_PROJECT) {
        // A project can never legitimately hold more keys than this cap regardless of how many
        // already exist, so this payload-only bound needs no DB lookup — `assertKeyCapNotExceeded`
        // (existing + incoming) still runs afterward for the case this alone cannot catch.
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: { resource: 'translation_keys', limit: MAX_TRANSLATION_KEYS_PER_PROJECT },
        })
    }
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

import { isNil } from '@aiqadam/shared'
import { SelectQueryBuilder } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { CellPredicate, CompiledFilter } from './record-filter'
import { RecordEntity, RecordSchema } from './record.entity'

const recordRepo = repoFactory(RecordEntity)

export const recordQuery = {
    // Filters the database can reproduce exactly are evaluated by the database, so a lookup for
    // one key stops loading every record and every cell of the table. The JS pass in
    // recordService.list stays the authority on what matches — SQL only ever removes rows that
    // pass would have rejected too — which is why an operator whose semantics Postgres does not
    // share (CO and the ordering ones, see record-filter.ts) carries no predicate and is simply
    // not pushed down.
    build({ projectId, tableId, recordIds, compiledFilters, limit }: BuildParams): SelectQueryBuilder<RecordSchema> {
        const query = recordRepo().createQueryBuilder('record')
            .where('record."projectId" = :projectId', { projectId })
            .andWhere('record."tableId" = :tableId', { tableId })
            .orderBy('record.created', 'ASC')

        if (!isNil(recordIds)) {
            if (recordIds.length === 0) {
                return query.andWhere('1 = 0')
            }
            query.andWhere('record."id" IN (:...recordIds)', { recordIds })
        }

        const pushedDownFilters = compiledFilters.filter((filter): filter is CompiledFilter & { sql: CellPredicate } => !isNil(filter.sql))
        pushedDownFilters.forEach((filter, index) => {
            const alias = `filtered_cell_${index}`
            const { condition, params } = buildCellCondition({ predicate: filter.sql, alias })
            const subQuery = `SELECT 1 FROM "cell" "${alias}" WHERE "${alias}"."recordId" = record."id" AND "${alias}"."projectId" = :projectId AND "${alias}"."fieldId" = :${alias}_fieldId${condition}`
            const negated = filter.sql.kind === 'notExists'
            query.andWhere(`${negated ? 'NOT EXISTS' : 'EXISTS'} (${subQuery})`, { ...params, [`${alias}_fieldId`]: filter.fieldId })
        })

        // LIMIT can only move into SQL once the JS pass has nothing left to remove, otherwise it
        // would cut rows before they are filtered and return short pages. `jsonPathEq` is pushed
        // down for its EXISTS-subquery filtering benefit but is deliberately NOT exact (see
        // buildJsonPathEqCondition) — it over-includes non-string leaves rather than risk a false
        // negative, so the JS pass can still reject rows out of a SQL result carrying it, and a
        // LIMIT taken before that would silently return a short page.
        const everyFilterIsExact = compiledFilters.every((filter) => !isNil(filter.sql) && filter.sql.kind !== 'jsonPathEq')
        if (everyFilterIsExact) {
            query.take(limit)
        }

        return query
    },
}

// NOT_EXISTS shares this body and is negated by the caller: a record matches it when no cell
// with a value exists, which covers both an empty cell and no cell row at all — exactly what
// `matchesMissingCell` means in JS.
//
// The two empty-list branches are reached: `Filter` rejects an empty list over HTTP, but the MCP
// tool builds one with `splitListValue`, which returns `[]` for a blank or comma-only value
// (`app/mcp/tools/ap-find-records.ts`). They mean what the matcher beside them means — `in []`
// matches nothing, `not_in []` excludes nothing but still requires the cell to exist.
function buildCellCondition({ predicate, alias }: { predicate: CellPredicate, alias: string }): { condition: string, params: Record<string, unknown> } {
    switch (predicate.kind) {
        case 'exists':
        case 'notExists':
            return { condition: ` AND "${alias}"."value" IS NOT NULL AND "${alias}"."value" <> ''`, params: {} }
        case 'eq':
            return { condition: ` AND "${alias}"."value" = :${alias}_value`, params: { [`${alias}_value`]: predicate.value } }
        case 'neq':
            return { condition: ` AND ("${alias}"."value" IS NULL OR "${alias}"."value" <> :${alias}_value)`, params: { [`${alias}_value`]: predicate.value } }
        case 'in':
            if (predicate.values.length === 0) {
                return { condition: ' AND 1 = 0', params: {} }
            }
            return { condition: ` AND "${alias}"."value" IN (:...${alias}_values)`, params: { [`${alias}_values`]: predicate.values } }
        case 'notIn':
            if (predicate.values.length === 0) {
                return { condition: '', params: {} }
            }
            return { condition: ` AND ("${alias}"."value" IS NULL OR "${alias}"."value" NOT IN (:...${alias}_values))`, params: { [`${alias}_values`]: predicate.values } }
        case 'jsonPathEq':
            return buildJsonPathEqCondition({ predicate, alias })
    }
}

// Only ever excludes a row when the extracted leaf is provably a JSON string — the one
// case where Postgres's `jsonb_extract_path_text` output and the JS matcher's decoded
// string are guaranteed to agree character-for-character. For every other leaf shape
// (number, boolean, null, object, array, or the path not resolving at all) the OR branch
// makes the predicate TRUE, i.e. it excludes nothing and leaves the row for the JS pass
// in record.service.ts to decide — because Postgres's jsonb text output preserves a
// number literal's original formatting ("1.0" stays "1.0") while
// `JSON.parse` + `String()` on the JS side does not (it becomes "1"), so comparing
// numbers as text here could make SQL reject a row the JS matcher would have kept. That
// is the one direction #413's invariant forbids — the column belongs to a JSON field by
// construction (record-filter.ts only ever compiles this predicate for one).
//
// The `::jsonb` cast itself assumes every non-empty cell of a JSON field is valid JSON,
// which cell-validation.ts guarantees for every write this API accepts — create, update,
// updateMany, upsert and the CSV importer all funnel through it (#390). A cell that
// reached the table by direct DB manipulation, bypassing the API, is the one way to
// violate that and make this cast raise a Postgres error instead of a JS "no match" —
// there is no portable, extension-free safe-cast for text→jsonb before Postgres 16's
// `IS JSON` predicate, and this repo runs pg14. Accepted as a documented limitation
// rather than adding a database function for it.
function buildJsonPathEqCondition({ predicate, alias }: { predicate: Extract<CellPredicate, { kind: 'jsonPathEq' }>, alias: string }): { condition: string, params: Record<string, unknown> } {
    const extractedPath = `jsonb_extract_path(NULLIF("${alias}"."value", '')::jsonb, VARIADIC string_to_array(:${alias}_path, '.'))`
    const condition = ` AND "${alias}"."value" IS NOT NULL AND "${alias}"."value" <> '' AND (` +
        `jsonb_typeof(${extractedPath}) IS DISTINCT FROM 'string' OR ` +
        `jsonb_extract_path_text(NULLIF("${alias}"."value", '')::jsonb, VARIADIC string_to_array(:${alias}_path, '.')) = :${alias}_value)`
    return {
        condition,
        params: {
            [`${alias}_path`]: predicate.path,
            [`${alias}_value`]: predicate.value,
        },
    }
}

type BuildParams = {
    projectId: string
    tableId: string
    recordIds: string[] | undefined
    compiledFilters: CompiledFilter[]
    limit: number
}

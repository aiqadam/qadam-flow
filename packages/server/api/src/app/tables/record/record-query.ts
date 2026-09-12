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
        // would cut rows before they are filtered and return short pages.
        if (pushedDownFilters.length === compiledFilters.length) {
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
    }
}

type BuildParams = {
    projectId: string
    tableId: string
    recordIds: string[] | undefined
    compiledFilters: CompiledFilter[]
    limit: number
}

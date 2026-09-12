import {
    assertNotNullOrUndefined,
    ErrorCode,
    Field,
    FieldType,
    Filter,
    FilterOperator,
    isNil,
    QadamFlowError,
    unique,
} from '@aiqadam/shared'

export const recordFilter = {
    // Resolves every filter against the table's columns once, before any row is
    // read. Operand parsing therefore raises on a value the column's type cannot
    // interpret even when the table is empty — an empty page is indistinguishable
    // from "nothing matched", which is what made this class of mistake expensive.
    compile({ filters, fields, tableId }: CompileParams): CompiledFilter[] {
        if (isNil(filters) || filters.length === 0) {
            return []
        }
        const fieldsById = new Map(fields.map((field) => [field.id, field]))
        assertEveryFilterNamesAColumn({ filters, fieldsById, tableId })
        return filters.map((filter) => {
            const field = fieldsById.get(filter.fieldId)
            assertNotNullOrUndefined(field, `column ${filter.fieldId}`)
            return compileFilter({ filter, field })
        })
    },

    matchesAll({ cells, compiledFilters }: MatchesAllParams): boolean {
        return compiledFilters.every((compiled) => {
            const cell = cells.find((candidate) => candidate.fieldId === compiled.fieldId)
            if (isNil(cell)) {
                return compiled.matchesMissingCell
            }
            return compiled.matchesCell(cell.value)
        })
    },
}

// A filter naming a column this table does not have matched no cell, which every
// operator but NOT_EXISTS read as "no rows" and NOT_EXISTS read as "all rows".
// Both are a filter silently not being applied, so reject it instead.
function assertEveryFilterNamesAColumn({ filters, fieldsById, tableId }: { filters: Filter[], fieldsById: Map<string, Field>, tableId: string }): void {
    const unknownFieldIds = unique(filters.map((filter) => filter.fieldId).filter((fieldId) => !fieldsById.has(fieldId)))
    if (unknownFieldIds.length === 0) {
        return
    }
    const message = truncate(`Filter references field(s) not present in table ${tableId}: ${unknownFieldIds.join(', ')}`)
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

function compileFilter({ filter, field }: { filter: Filter, field: Field }): CompiledFilter {
    switch (filter.operator) {
        case FilterOperator.EXISTS:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => !isEmptyCell(value), sql: { kind: 'exists' } }
        case FilterOperator.NOT_EXISTS:
            return { fieldId: filter.fieldId, matchesMissingCell: true, matchesCell: isEmptyCell, sql: { kind: 'notExists' } }
        case FilterOperator.EQ:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => value === filter.value, sql: { kind: 'eq', value: filter.value } }
        case FilterOperator.NEQ:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => value !== filter.value, sql: { kind: 'neq', value: filter.value } }
        case FilterOperator.CO:
            // No `sql`: `toLowerCase` folds by Unicode's own rules, `lower()` by the
            // database's collation, and the two disagree (ß, Turkish dotted I, …). A
            // pre-filter that drops a row this matcher would keep is a wrong result,
            // not a slower one, so CO stays in JS.
            return {
                fieldId: filter.fieldId,
                matchesMissingCell: false,
                matchesCell: (value) => typeof value === 'string' && value.toLowerCase().includes(filter.value.toLowerCase()),
            }
        case FilterOperator.IN:
            return {
                fieldId: filter.fieldId,
                matchesMissingCell: false,
                matchesCell: (value) => typeof value === 'string' && filter.value.includes(value),
                sql: { kind: 'in', values: filter.value },
            }
        case FilterOperator.NOT_IN:
            // A null/empty cell counts as "not in the list" (included), matching
            // NEQ. Note the outer guard still excludes records that have no cell
            // row at all for this field, as it does for every non-NOT_EXISTS
            // operator.
            return {
                fieldId: filter.fieldId,
                matchesMissingCell: false,
                matchesCell: (value) => typeof value !== 'string' || !filter.value.includes(value),
                sql: { kind: 'notIn', values: filter.value },
            }
        case FilterOperator.GT:
        case FilterOperator.GTE:
        case FilterOperator.LT:
        case FilterOperator.LTE:
            return {
                fieldId: filter.fieldId,
                matchesMissingCell: false,
                matchesCell: buildOrderingMatcher({ field, operator: filter.operator, value: filter.value }),
            }
    }
}

// The operand is parsed once, here, so an uninterpretable filter value raises.
// A cell that cannot be interpreted is a different case and only fails to match:
// cell values are data, and one CSV-imported junk row must not fail the query.
function buildOrderingMatcher({ field, operator, value }: { field: Field, operator: OrderingOperator, value: string }): (cellValue: unknown) => boolean {
    switch (field.type) {
        case FieldType.NUMBER: {
            const operand = toFiniteNumber(value)
            if (isNil(operand)) {
                throw uninterpretableOperand({ field, operator, value, expected: 'a number' })
            }
            return (cellValue) => {
                const cell = toFiniteNumber(cellValue)
                return isNil(cell) ? false : matchesOrdering({ operator, comparison: Math.sign(cell - operand) })
            }
        }
        case FieldType.DATE: {
            const operand = toDateOperand({ value, operator })
            if (isNil(operand)) {
                throw uninterpretableOperand({ field, operator, value, expected: 'a date' })
            }
            return (cellValue) => {
                const cell = toTimestamp(cellValue)
                return isNil(cell) ? false : matchesOrdering({ operator, comparison: Math.sign(cell - operand) })
            }
        }
        // Ordered case-insensitively, for the same reason CO is matched
        // case-insensitively: a column of names should not sort "Zoe" before "alice".
        case FieldType.TEXT:
        case FieldType.STATIC_DROPDOWN: {
            // Symmetric with the two branches above, and load-bearing: an empty
            // cell is excluded by toComparableText, so without this every
            // non-empty cell compares strictly greater than "" and `gt`/`gte`
            // match the whole table. A binding that resolves to an empty string
            // — an absent optional field on a trigger payload — is the ordinary
            // way to get here.
            if (value.trim().length === 0) {
                throw uninterpretableOperand({ field, operator, value, expected: 'a value to compare against' })
            }
            const operand = value.toLowerCase()
            return (cellValue) => {
                const cell = toComparableText(cellValue)
                return isNil(cell) ? false : matchesOrdering({ operator, comparison: compareText({ left: cell, right: operand }) })
            }
        }
    }
}

function matchesOrdering({ operator, comparison }: { operator: OrderingOperator, comparison: number }): boolean {
    switch (operator) {
        case FilterOperator.GT:
            return comparison > 0
        case FilterOperator.GTE:
            return comparison >= 0
        case FilterOperator.LT:
            return comparison < 0
        case FilterOperator.LTE:
            return comparison <= 0
    }
}

// Collated, not compared by code unit. `'ёлка' > 'яблоко'` is true in code-unit
// order and false alphabetically, and this product's primary locales are Cyrillic —
// so the plain `<` the props now advertise as "alphabetically" would be wrong for
// most of its users. The locale is pinned rather than left to the host's LANG, so
// the same filter cannot order differently on two deployments.
function compareText({ left, right }: { left: string, right: string }): number {
    return Math.sign(COLLATOR.compare(left, right))
}

// Decimal only. `Number('0x10')` is 16 where the qadam's own operand validation
// and the previous implementation both read it as something else, and a cell
// written as hex by a CSV import must not start matching `gt 0` because the
// comparison changed underneath it. Widening on a NUMBER column is not part of
// this fix.
function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed !== parseFloat(value)) {
        return null
    }
    return parsed
}

// A date-only operand names a DAY, so it is anchored to whichever end of that day
// the operator means: "on or before the 11th" has to include the 11th.
//
// Reading it literally as 00:00 was the first design here, and it is wrong for the
// normal case rather than an edge one: the Tables editor stores a picked date at
// LOCAL NOON (packages/web/src/features/tables/components/date-editor.tsx), so a
// row the user sees as "11 Sep" is stored after 00:00 UTC in every timezone and
// `lte 2026-09-11` would exclude the very day it names — a silent empty result,
// which is the failure this whole module is about.
//
// An operand carrying a time is untouched; only a bare YYYY-MM-DD expands. The one
// case this still gets wrong is a user at UTC+13/+14, where local noon falls on the
// previous UTC day.
function toDateOperand({ value, operator }: { value: string, operator: OrderingOperator }): number | null {
    const timestamp = toTimestamp(value)
    if (isNil(timestamp) || !DATE_ONLY_PATTERN.test(value.trim())) {
        return timestamp
    }
    const endOfDay = operator === FilterOperator.GT || operator === FilterOperator.LTE
    return endOfDay ? timestamp + MILLISECONDS_PER_DAY - 1 : timestamp
}

function toTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null
    }
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
}

function toComparableText(value: unknown): string | null {
    if (isEmptyCell(value)) {
        return null
    }
    if (typeof value === 'string') {
        return value.toLowerCase()
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value).toLowerCase()
    }
    return null
}

function isEmptyCell(value: unknown): boolean {
    return isNil(value) || value === ''
}

function uninterpretableOperand({ field, operator, value, expected }: { field: Field, operator: OrderingOperator, value: string, expected: string }): QadamFlowError {
    const name = truncate(field.name)
    const message = `Filter "${operator}" on column "${name}" needs ${expected}, but got "${truncate(value)}". Column "${name}" is of type ${field.type}.`
    return new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// Every interpolated value is bounded, not just the operand: this message is
// carried on `Error.message` and lands in server logs and persisted run output.
function truncate(value: string): string {
    return value.length <= MAX_REPORTED_VALUE_LENGTH ? value : `${value.slice(0, MAX_REPORTED_VALUE_LENGTH)}…`
}

const MAX_REPORTED_VALUE_LENGTH = 100

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const COLLATOR = new Intl.Collator('en')

type OrderingOperator = FilterOperator.GT | FilterOperator.GTE | FilterOperator.LT | FilterOperator.LTE

type CompileParams = {
    filters: Filter[] | null
    fields: Field[]
    tableId: string
}

type MatchesAllParams = {
    cells: { fieldId: string, value: unknown }[]
    compiledFilters: CompiledFilter[]
}

// `cell.value` is a varchar, so every value Postgres hands back is a string and these
// predicates mean exactly what the matcher beside them means. Operators whose JS semantics
// the database cannot reproduce carry no `sql` and are filtered in JS alone.
export type CellPredicate =
    | { kind: 'eq', value: string }
    | { kind: 'neq', value: string }
    | { kind: 'in', values: string[] }
    | { kind: 'notIn', values: string[] }
    | { kind: 'exists' }
    | { kind: 'notExists' }

export type CompiledFilter = {
    fieldId: string
    matchesMissingCell: boolean
    matchesCell: (cellValue: unknown) => boolean
    sql?: CellPredicate
}

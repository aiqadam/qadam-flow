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
    const message = `Filter references field(s) not present in table ${tableId}: ${unknownFieldIds.join(', ')}`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

function compileFilter({ filter, field }: { filter: Filter, field: Field }): CompiledFilter {
    switch (filter.operator) {
        case FilterOperator.EXISTS:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => !isEmptyCell(value) }
        case FilterOperator.NOT_EXISTS:
            return { fieldId: filter.fieldId, matchesMissingCell: true, matchesCell: isEmptyCell }
        case FilterOperator.EQ:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => value === filter.value }
        case FilterOperator.NEQ:
            return { fieldId: filter.fieldId, matchesMissingCell: false, matchesCell: (value) => value !== filter.value }
        case FilterOperator.CO:
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
            const operand = toTimestamp(value)
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

function compareText({ left, right }: { left: string, right: string }): number {
    if (left < right) {
        return -1
    }
    return left > right ? 1 : 0
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        return null
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

// A date-only operand is read literally: `lte 2026-09-11` is 00:00 on the 11th,
// not the end of that day. Expanding it would be a second surprise rather than
// the removal of one.
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
    const shown = value.length > MAX_REPORTED_VALUE_LENGTH ? `${value.slice(0, MAX_REPORTED_VALUE_LENGTH)}…` : value
    const message = `Filter "${operator}" on column "${field.name}" needs ${expected}, but got "${shown}". Column "${field.name}" is of type ${field.type}.`
    return new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

const MAX_REPORTED_VALUE_LENGTH = 100

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

export type CompiledFilter = {
    fieldId: string
    matchesMissingCell: boolean
    matchesCell: (cellValue: unknown) => boolean
}

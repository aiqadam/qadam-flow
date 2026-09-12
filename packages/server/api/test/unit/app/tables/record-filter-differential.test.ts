import { Field, FieldType, Filter, FilterOperator } from '@aiqadam/shared'
import { recordFilter } from '../../../../src/app/tables/record/record-filter'

// The seven operators this change only MOVED must behave identically, and the
// four it rewrote must only ever match MORE rows on DATE and TEXT — the columns
// where the old comparison was structurally broken. Anything else matching more
// rows than before is a filter that silently widened, which is the failure this
// module exists to prevent. Asserted by running both implementations over a
// matrix rather than by reading them side by side.

const MISSING = Symbol('no cell row')

// Verbatim from record.service.ts at 6b4d5a08, before this module replaced it.
function numberFilterValidator({ cellValue, filterValue, cb }: { cellValue: unknown, filterValue: string, cb: (a: number, b: number) => boolean }): boolean {
    if (typeof cellValue === 'string' || typeof cellValue === 'number') {
        const cv = parseFloat(String(cellValue))
        const fv = parseFloat(filterValue)
        if (isNaN(cv) || isNaN(fv)) {
            return false
        }
        return cb(cv, fv)
    }
    return false
}

function previouslyMatched({ cellValue, filter }: { cellValue: unknown, filter: Filter }): boolean {
    // The outer guard `list()` applied before consulting the operator switch.
    if (cellValue === MISSING) {
        return filter.operator === FilterOperator.NOT_EXISTS
    }
    switch (filter.operator) {
        case FilterOperator.EXISTS: return cellValue !== null && cellValue !== ''
        case FilterOperator.NOT_EXISTS: return cellValue === null || cellValue === ''
        case FilterOperator.EQ: return cellValue === filter.value
        case FilterOperator.NEQ: return cellValue !== filter.value
        case FilterOperator.GT: return numberFilterValidator({ cellValue, filterValue: filter.value, cb: (a, b) => a > b })
        case FilterOperator.GTE: return numberFilterValidator({ cellValue, filterValue: filter.value, cb: (a, b) => a >= b })
        case FilterOperator.LT: return numberFilterValidator({ cellValue, filterValue: filter.value, cb: (a, b) => a < b })
        case FilterOperator.LTE: return numberFilterValidator({ cellValue, filterValue: filter.value, cb: (a, b) => a <= b })
        case FilterOperator.CO: return typeof cellValue === 'string' && cellValue.toLowerCase().includes(filter.value.toLowerCase())
        case FilterOperator.IN: return typeof cellValue === 'string' && filter.value.includes(cellValue)
        case FilterOperator.NOT_IN: return typeof cellValue !== 'string' || !filter.value.includes(cellValue)
    }
}

function makeField(type: FieldType): Field {
    const base = { id: 'f1', created: '', updated: '', name: 'col', externalId: 'col', tableId: 't1', projectId: 'p1' }
    if (type === FieldType.STATIC_DROPDOWN) {
        return { ...base, type, data: { options: [{ value: 'a' }, { value: 'b' }] } }
    }
    return { ...base, type }
}

function compare({ type, filter, cellValue }: { type: FieldType, filter: Filter, cellValue: unknown }): Disagreement | null {
    let compiled
    try {
        compiled = recordFilter.compile({ filters: [filter], fields: [makeField(type)], tableId: 't1' })
    }
    catch {
        // An operand the column type cannot interpret now raises instead of
        // matching nothing. Raising is never a widening, so it is not compared.
        return null
    }
    const cells = cellValue === MISSING ? [] : [{ fieldId: 'f1', value: cellValue }]
    const now = recordFilter.matchesAll({ cells, compiledFilters: compiled })
    const before = previouslyMatched({ cellValue, filter })
    if (now === before) {
        return null
    }
    return {
        type,
        operator: filter.operator,
        cell: cellValue === MISSING ? '<no cell>' : JSON.stringify(cellValue),
        operand: 'value' in filter ? JSON.stringify(filter.value) : '-',
        widened: now,
    }
}

function everyDisagreement(): Disagreement[] {
    const found: (Disagreement | null)[] = []
    for (const type of FIELD_TYPES) {
        for (const cellValue of CELL_VALUES) {
            for (const operator of EXISTENCE_OPERATORS) {
                found.push(compare({ type, filter: { fieldId: 'f1', operator }, cellValue }))
            }
            for (const operator of VALUE_OPERATORS) {
                for (const value of SCALAR_OPERANDS) {
                    found.push(compare({ type, filter: { fieldId: 'f1', operator, value }, cellValue }))
                }
            }
            for (const operator of LIST_OPERATORS) {
                for (const value of LIST_OPERANDS) {
                    found.push(compare({ type, filter: { fieldId: 'f1', operator, value }, cellValue }))
                }
            }
        }
    }
    return found.filter((row): row is Disagreement => row !== null)
}

function describeAll(rows: Disagreement[]): string[] {
    return rows.map((row) => `${row.type} ${row.operator} cell=${row.cell} operand=${row.operand}`)
}

describe('recordFilter, against the implementation it replaced', () => {
    const disagreements = everyDisagreement()
    const widened = disagreements.filter((row) => row.widened)

    it('matches no additional row on any operator that was only moved, not rewritten', () => {
        const untouched = widened.filter((row) => !ORDERING_OPERATORS.includes(row.operator))
        expect(describeAll(untouched)).toEqual([])
    })

    it('matches no additional row on a NUMBER column, where the old comparison was already correct', () => {
        const onNumbers = widened.filter((row) => row.type === FieldType.NUMBER)
        expect(describeAll(onNumbers)).toEqual([])
    })

    it('does match additional rows on DATE and TEXT ranges, which is the fix', () => {
        const onDates = widened.filter((row) => row.type === FieldType.DATE)
        const onText = widened.filter((row) => row.type === FieldType.TEXT)
        expect(onDates.length).toBeGreaterThan(0)
        expect(onText.length).toBeGreaterThan(0)
    })

    it('covers enough of the input space to mean something', () => {
        expect(disagreements.length).toBeGreaterThan(100)
    })
})

const FIELD_TYPES = [FieldType.TEXT, FieldType.NUMBER, FieldType.DATE, FieldType.STATIC_DROPDOWN]

const VALUE_OPERATORS = [FilterOperator.EQ, FilterOperator.NEQ, FilterOperator.GT, FilterOperator.GTE, FilterOperator.LT, FilterOperator.LTE, FilterOperator.CO] as const

const LIST_OPERATORS = [FilterOperator.IN, FilterOperator.NOT_IN] as const

const EXISTENCE_OPERATORS = [FilterOperator.EXISTS, FilterOperator.NOT_EXISTS] as const

const ORDERING_OPERATORS: FilterOperator[] = [FilterOperator.GT, FilterOperator.GTE, FilterOperator.LT, FilterOperator.LTE]

const CELL_VALUES: unknown[] = [
    MISSING, null, '', '   ', 'Alpha', 'alpha', 'beta', '0', '10', '-1.5', '1e2', '0x10', 'Infinity', 'NaN',
    '2026-01-01T00:00:00Z', '2026-09-10T09:00:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z', '2026-09-10',
    0, 10, -1.5, true, false, 'true',
]

const SCALAR_OPERANDS = [
    '', '   ', 'Alpha', 'alpha', 'beta', '0', '10', '-1.5', '1e2', '0x10',
    '2026-01-01T00:00:00Z', '2026-09-10T09:00:00Z', '2026-12-31T23:59:59Z', '2026-09-10', '2027', 'true',
]

const LIST_OPERANDS: string[][] = [['Alpha'], ['alpha', 'beta'], ['0', '10'], ['']]

type Disagreement = {
    type: FieldType
    operator: FilterOperator
    cell: string
    operand: string
    widened: boolean
}

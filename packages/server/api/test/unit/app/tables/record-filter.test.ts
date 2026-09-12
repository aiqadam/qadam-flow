import { ErrorCode, Field, FieldType, Filter, FilterOperator, QadamFlowError } from '@aiqadam/shared'
import { recordFilter } from '../../../../src/app/tables/record/record-filter'

const TABLE_ID = 'table_1'

function field({ id, type }: { id: string, type: FieldType.TEXT | FieldType.NUMBER | FieldType.DATE }): Field {
    return {
        id,
        created: '2026-09-01T00:00:00.000Z',
        updated: '2026-09-01T00:00:00.000Z',
        name: id,
        externalId: id,
        type,
        tableId: TABLE_ID,
        projectId: 'project_1',
    }
}

const dropdownField: Field = {
    id: 'status',
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-01T00:00:00.000Z',
    name: 'status',
    externalId: 'status',
    type: FieldType.STATIC_DROPDOWN,
    tableId: TABLE_ID,
    projectId: 'project_1',
    data: { options: [{ value: 'draft' }, { value: 'shipped' }] },
}

const fields: Field[] = [
    field({ id: 'title', type: FieldType.TEXT }),
    field({ id: 'starts_at', type: FieldType.DATE }),
    field({ id: 'overbook_pct', type: FieldType.NUMBER }),
    dropdownField,
]

function matches({ filter, cellValue }: { filter: Filter, cellValue: unknown }): boolean {
    const compiledFilters = recordFilter.compile({ filters: [filter], fields, tableId: TABLE_ID })
    return recordFilter.matchesAll({ cells: [{ fieldId: filter.fieldId, value: cellValue }], compiledFilters })
}

describe('recordFilter', () => {
    describe('DATE ordering (#383)', () => {
        it('matches a cell earlier the same day, which parseFloat could not (the reported symptom)', () => {
            expect(matches({
                filter: { fieldId: 'starts_at', operator: FilterOperator.LT, value: '2026-09-11T00:00:00Z' },
                cellValue: '2026-09-10T09:00:00Z',
            })).toBe(true)
        })

        it('does not match a cell later the same year under gte (the unreported false positive)', () => {
            // parseFloat truncated both sides to 2026, so `2026 >= 2026` matched
            // every row whose date fell in the same year as the filter value.
            expect(matches({
                filter: { fieldId: 'starts_at', operator: FilterOperator.GTE, value: '2026-12-31T23:59:59Z' },
                cellValue: '2026-01-01T00:00:00Z',
            })).toBe(false)
        })

        it('orders within a single year', () => {
            expect(matches({
                filter: { fieldId: 'starts_at', operator: FilterOperator.GT, value: '2026-01-01T00:00:00Z' },
                cellValue: '2026-12-31T23:59:59Z',
            })).toBe(true)
        })

        it('treats gte/lte as inclusive at the boundary', () => {
            const cellValue = '2026-09-10T09:00:00.000Z'
            expect(matches({ filter: { fieldId: 'starts_at', operator: FilterOperator.GTE, value: cellValue }, cellValue })).toBe(true)
            expect(matches({ filter: { fieldId: 'starts_at', operator: FilterOperator.LTE, value: cellValue }, cellValue })).toBe(true)
            expect(matches({ filter: { fieldId: 'starts_at', operator: FilterOperator.GT, value: cellValue }, cellValue })).toBe(false)
        })

        it('reads a date-only operand literally, as 00:00 of that day', () => {
            expect(matches({
                filter: { fieldId: 'starts_at', operator: FilterOperator.LTE, value: '2026-09-11' },
                cellValue: '2026-09-11T09:00:00Z',
            })).toBe(false)
        })

        it('excludes an empty or uninterpretable cell rather than failing the query', () => {
            for (const cellValue of ['', null, undefined, 'not a date', 42]) {
                expect(matches({
                    filter: { fieldId: 'starts_at', operator: FilterOperator.LT, value: '2026-09-11T00:00:00Z' },
                    cellValue,
                })).toBe(false)
            }
        })
    })

    describe('TEXT and dropdown ordering', () => {
        it('compares lexicographically instead of always returning nothing', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.GT, value: 'A' }, cellValue: 'Beta' })).toBe(true)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.LT, value: 'A' }, cellValue: 'Beta' })).toBe(false)
        })

        it('is case-insensitive, so "Zoe" does not sort before "alice"', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.GT, value: 'alice' }, cellValue: 'Zoe' })).toBe(true)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.GTE, value: 'APPLE' }, cellValue: 'apple' })).toBe(true)
        })

        it('orders a single-select column too', () => {
            expect(matches({ filter: { fieldId: 'status', operator: FilterOperator.GT, value: 'draft' }, cellValue: 'shipped' })).toBe(true)
        })

        it('excludes an empty cell', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.GTE, value: 'a' }, cellValue: '' })).toBe(false)
        })
    })

    describe('NUMBER ordering is unchanged', () => {
        it.each<[OrderingOperator, string, string, boolean]>([
            [FilterOperator.GT, '10', '40', true],
            [FilterOperator.GT, '40', '40', false],
            [FilterOperator.GTE, '40', '40', true],
            [FilterOperator.LT, '0', '-1.5', true],
            [FilterOperator.LTE, '-1.5', '-1.5', true],
        ])('%s %s against cell %s', (operator, value, cellValue, expected) => {
            expect(matches({ filter: { fieldId: 'overbook_pct', operator, value }, cellValue })).toBe(expected)
        })

        it('excludes a blank or non-numeric cell', () => {
            for (const cellValue of ['', '   ', 'ten', null]) {
                expect(matches({ filter: { fieldId: 'overbook_pct', operator: FilterOperator.GT, value: '0' }, cellValue })).toBe(false)
            }
        })
    })

    describe('an uninterpretable filter value raises instead of returning an empty page', () => {
        // The blank cases are the ones that bite: an empty cell is excluded from
        // ordering, so a blank operand on a text column would otherwise compare
        // strictly less than every non-empty cell and match the whole table.
        it.each([
            ['a non-numeric value on a Number column', 'overbook_pct', 'ten'],
            ['an unparseable value on a Date column', 'starts_at', 'yesterday'],
            ['epoch milliseconds on a Date column', 'starts_at', '1757494800000'],
            ['a blank value on a Number column', 'overbook_pct', '  '],
            ['a blank value on a Date column', 'starts_at', '  '],
            ['an empty value on a Text column', 'title', ''],
            ['a whitespace value on a Text column', 'title', '   '],
            ['an empty value on a Single Select column', 'status', ''],
        ])('%s', (_label, fieldId, value) => {
            expect(() => recordFilter.compile({
                filters: [{ fieldId, operator: FilterOperator.LT, value }],
                fields,
                tableId: TABLE_ID,
            })).toThrow(QadamFlowError)
        })

        it('raises even when the table holds no rows at all, because compile never sees a row', () => {
            let thrown: unknown
            try {
                recordFilter.compile({
                    filters: [{ fieldId: 'starts_at', operator: FilterOperator.GT, value: 'yesterday' }],
                    fields,
                    tableId: TABLE_ID,
                })
            }
            catch (error) {
                thrown = error
            }
            expect(thrown).toBeInstanceOf(QadamFlowError)
            if (thrown instanceof QadamFlowError) {
                expect(thrown.error.code).toBe(ErrorCode.VALIDATION)
            }
        })

        it('rejects a filter naming a column the table does not have', () => {
            expect(() => recordFilter.compile({
                filters: [{ fieldId: 'from_another_table', operator: FilterOperator.NOT_EXISTS }],
                fields,
                tableId: TABLE_ID,
            })).toThrow(QadamFlowError)
        })
    })

    describe('the operators this change does not touch keep their semantics', () => {
        it('EXISTS / NOT_EXISTS treat null and empty string as absent', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.EXISTS }, cellValue: 'hello' })).toBe(true)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.EXISTS }, cellValue: '' })).toBe(false)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.NOT_EXISTS }, cellValue: null })).toBe(true)
        })

        it('NOT_EXISTS is the only operator that matches a record with no cell row for the field', () => {
            const compiledFilters = recordFilter.compile({
                filters: [{ fieldId: 'title', operator: FilterOperator.NOT_EXISTS }],
                fields,
                tableId: TABLE_ID,
            })
            expect(recordFilter.matchesAll({ cells: [], compiledFilters })).toBe(true)

            const eqFilters = recordFilter.compile({
                filters: [{ fieldId: 'title', operator: FilterOperator.EQ, value: 'hello' }],
                fields,
                tableId: TABLE_ID,
            })
            expect(recordFilter.matchesAll({ cells: [], compiledFilters: eqFilters })).toBe(false)
        })

        it('EQ / NEQ stay exact string comparisons, including on a Date column', () => {
            expect(matches({ filter: { fieldId: 'starts_at', operator: FilterOperator.EQ, value: '2026-09-10T09:00:00Z' }, cellValue: '2026-09-10T09:00:00Z' })).toBe(true)
            expect(matches({ filter: { fieldId: 'starts_at', operator: FilterOperator.EQ, value: '2026-09-10' }, cellValue: '2026-09-10T00:00:00.000Z' })).toBe(false)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.NEQ, value: 'a' }, cellValue: 'b' })).toBe(true)
        })

        it('CO is case-insensitive', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.CO, value: 'ETA' }, cellValue: 'Beta' })).toBe(true)
        })

        it('IN includes a listed value and NOT_IN includes a null cell', () => {
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.IN, value: ['a', 'c'] }, cellValue: 'a' })).toBe(true)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.IN, value: ['a', 'c'] }, cellValue: 'b' })).toBe(false)
            expect(matches({ filter: { fieldId: 'title', operator: FilterOperator.NOT_IN, value: ['a'] }, cellValue: null })).toBe(true)
        })
    })

    describe('compile with no filters', () => {
        it.each([
            ['null', null],
            ['an empty list', []],
        ])('returns nothing to match against for %s', (_label, filters) => {
            const compiledFilters = recordFilter.compile({ filters, fields, tableId: TABLE_ID })
            expect(compiledFilters).toEqual([])
            expect(recordFilter.matchesAll({ cells: [], compiledFilters })).toBe(true)
        })
    })
})

type OrderingOperator = FilterOperator.GT | FilterOperator.GTE | FilterOperator.LT | FilterOperator.LTE

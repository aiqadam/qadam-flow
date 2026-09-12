import { Field, FieldType, Filter, FilterOperator } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import qs from 'qs'
import { recordFilter } from '../../../../src/app/tables/record/record-filter'
import { recordQuery } from '../../../../src/app/tables/record/record-query'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import { createMockCell, createMockField, createMockRecord, createMockTable } from '../../../helpers/mocks'
import { TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// Values chosen for the places SQL and JS are most likely to disagree: LIKE metacharacters,
// a quote, case folding that Unicode and a database collation do not perform identically,
// Cyrillic ordering, an empty cell, and a record carrying no cell at all.
const CELL_VALUES = ['a', 'A', 'ß', 'İ', '', '100%', 'under_score', 'quo\'te', 'ёлка', 'яблоко', '5', '0x10', ' spaced ']

const FILTER_CASES: { label: string, build: (fieldId: string) => Filter[] }[] = [
    { label: 'EQ a', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: 'a' }] },
    { label: 'EQ empty', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: '' }] },
    { label: 'EQ 100%', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: '100%' }] },
    { label: 'EQ under_score', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: 'under_score' }] },
    { label: 'EQ quote', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: 'quo\'te' }] },
    { label: 'NEQ a', build: (fieldId) => [{ fieldId, operator: FilterOperator.NEQ, value: 'a' }] },
    { label: 'NEQ empty', build: (fieldId) => [{ fieldId, operator: FilterOperator.NEQ, value: '' }] },
    { label: 'IN a,ёлка', build: (fieldId) => [{ fieldId, operator: FilterOperator.IN, value: ['a', 'ёлка'] }] },
    { label: 'NOT_IN a', build: (fieldId) => [{ fieldId, operator: FilterOperator.NOT_IN, value: ['a'] }] },
    { label: 'EXISTS', build: (fieldId) => [{ fieldId, operator: FilterOperator.EXISTS }] },
    { label: 'NOT_EXISTS', build: (fieldId) => [{ fieldId, operator: FilterOperator.NOT_EXISTS }] },
    { label: 'CO a', build: (fieldId) => [{ fieldId, operator: FilterOperator.CO, value: 'a' }] },
    { label: 'CO ß', build: (fieldId) => [{ fieldId, operator: FilterOperator.CO, value: 'ß' }] },
    { label: 'CO i', build: (fieldId) => [{ fieldId, operator: FilterOperator.CO, value: 'i' }] },
    { label: 'GT a', build: (fieldId) => [{ fieldId, operator: FilterOperator.GT, value: 'a' }] },
    { label: 'LTE яблоко', build: (fieldId) => [{ fieldId, operator: FilterOperator.LTE, value: 'яблоко' }] },
    { label: 'EQ a AND EXISTS', build: (fieldId) => [{ fieldId, operator: FilterOperator.EQ, value: 'a' }, { fieldId, operator: FilterOperator.EXISTS }] },
    { label: 'CO a AND NEQ A', build: (fieldId) => [{ fieldId, operator: FilterOperator.CO, value: 'a' }, { fieldId, operator: FilterOperator.NEQ, value: 'A' }] },
]

describe('Record filter pushdown', () => {

    // The database now evaluates the operators it can reproduce exactly, so the guarantee under
    // test is that it changed nothing: for every filter, what the endpoint returns must equal
    // what the JS matcher alone selects out of the whole table.
    describeWithAuth('GET /v1/records (filters evaluated in SQL)', () => app!, (setup) => {
        it.each(FILTER_CASES)('agrees with the JS matcher for $label', async ({ build }) => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)
            const filters = build(field.id)

            const returnedIds = await listRecordIds({ ctx, tableId: table.id, filters })
            const expectedIds = await matchedInJs({ tableId: table.id, projectId: ctx.project.id, fields: [field], filters })

            expect(returnedIds.slice().sort()).toEqual(expectedIds.slice().sort())
        })

        // LIMIT may only move into SQL once nothing is left for the JS pass to drop. A filter
        // that stays in JS alongside a limit is the case that returns short pages if it does.
        it('returns a full page when a JS-only filter is combined with a limit', async () => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)
            const filters: Filter[] = [{ fieldId: field.id, operator: FilterOperator.CO, value: 'a' }]

            const expectedIds = await matchedInJs({ tableId: table.id, projectId: ctx.project.id, fields: [field], filters })
            expect(expectedIds.length).toBeGreaterThan(2)

            const returnedIds = await listRecordIds({ ctx, tableId: table.id, filters, limit: 2 })

            expect(returnedIds.length).toBe(2)
        })

        it('applies a limit to a filter the database evaluates', async () => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)
            const filters: Filter[] = [{ fieldId: field.id, operator: FilterOperator.EXISTS }]

            const returnedIds = await listRecordIds({ ctx, tableId: table.id, filters, limit: 3 })

            expect(returnedIds.length).toBe(3)
        })

        // Everything above stays green if the pushdown is deleted, because the JS pass would
        // still produce the same rows — just after loading the whole table. This is the part
        // that fails when the work stops happening in the database.
        it('asks the database to do the filtering it can do', async () => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)

            const pushedDown = recordQuery.build({
                projectId: ctx.project.id,
                tableId: table.id,
                recordIds: undefined,
                compiledFilters: recordFilter.compile({ filters: [{ fieldId: field.id, operator: FilterOperator.EQ, value: 'a' }], fields: [field], tableId: table.id }),
                limit: 10,
            }).getQuery()

            expect(pushedDown).toContain('EXISTS')
            expect(pushedDown).toContain('"cell"')
            expect(pushedDown).toContain('LIMIT')
        })

        it('leaves an operator it cannot reproduce to the JS pass, limit included', async () => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)

            const notPushedDown = recordQuery.build({
                projectId: ctx.project.id,
                tableId: table.id,
                recordIds: undefined,
                compiledFilters: recordFilter.compile({ filters: [{ fieldId: field.id, operator: FilterOperator.CO, value: 'a' }], fields: [field], tableId: table.id }),
                limit: 10,
            }).getQuery()

            expect(notPushedDown).not.toContain('EXISTS')
            expect(notPushedDown).not.toContain('LIMIT')
        })

        it('reads a record id list together with a filter as both conditions', async () => {
            const ctx = await setup()
            const { table, field } = await seedTable(ctx)
            const everyMatch = await matchedInJs({
                tableId: table.id,
                projectId: ctx.project.id,
                fields: [field],
                filters: [{ fieldId: field.id, operator: FilterOperator.EXISTS }],
            })

            const returnedIds = await listRecordIds({
                ctx,
                tableId: table.id,
                filters: [{ fieldId: field.id, operator: FilterOperator.EXISTS }],
                recordIds: [everyMatch[0]],
            })

            expect(returnedIds).toEqual([everyMatch[0]])
        })
    })
})

async function seedTable(ctx: TestContext) {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
    field.type = FieldType.TEXT
    await db.save('field', field)

    for (const value of CELL_VALUES) {
        const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
        await db.save('record', record)
        const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
        cell.value = value
        await db.save('cell', cell)
    }
    // No cell row at all, which is a different case from an empty one for every operator.
    await db.save('record', createMockRecord({ tableId: table.id, projectId: ctx.project.id }))

    return { table, field }
}

async function listRecordIds({ ctx, tableId, filters, limit, recordIds }: { ctx: TestContext, tableId: string, filters: Filter[], limit?: number, recordIds?: string[] }): Promise<string[]> {
    const response = await ctx.inject({
        method: 'GET',
        url: `/api/v1/records?${qs.stringify({ tableId, filters, limit: limit ?? 1000, recordIds })}`,
    })
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response?.json().data.map((record: { id: string }) => record.id)
}

// The pre-pushdown path, verbatim: load the whole table, then let the matcher decide.
async function matchedInJs({ tableId, projectId, fields, filters }: { tableId: string, projectId: string, fields: Field[], filters: Filter[] }): Promise<string[]> {
    const compiledFilters = recordFilter.compile({ filters, fields, tableId })
    const records = await db.find<{ id: string }>('record', { tableId, projectId })
    const cells = await db.find<{ recordId: string, fieldId: string, value: string }>('cell', { projectId })
    return records
        .filter((record) => recordFilter.matchesAll({
            cells: cells.filter((cell) => cell.recordId === record.id),
            compiledFilters,
        }))
        .map((record) => record.id)
}

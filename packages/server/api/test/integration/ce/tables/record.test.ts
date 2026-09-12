import { apId, FieldType, FilterOperator } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import qs from 'qs'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import {
    createMockCell,
    createMockField,
    createMockRecord,
    createMockTable,
} from '../../../helpers/mocks'
import { TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Record API', () => {

    describeWithAuth('POST /v1/records (Create)', () => app!, (setup) => {
        it('should create a single record with cells', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [
                    [{ fieldId: field.id, value: 'hello' }],
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.length).toBe(1)
            expect(body[0].tableId).toBe(table.id)
            expect(body[0].cells[field.id]).toBeDefined()
            expect(body[0].cells[field.id].value).toBe('hello')
            expect(body[0].cells[field.id].fieldName).toBe(field.name)
        })

        it('should create multiple records in batch', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [
                    [{ fieldId: field.id, value: 'row1' }],
                    [{ fieldId: field.id, value: 'row2' }],
                    [{ fieldId: field.id, value: 'row3' }],
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.length).toBe(3)
        })

        it('should create a record with a numeric value coerced to string', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [
                    [{ fieldId: field.id, value: 0 }],
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body[0].cells[field.id].value).toBe('0')
        })

        it('should accept null value without coercing to "null" string', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [
                    [{ fieldId: field.id, value: null }],
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body[0].cells[field.id].value).toBe('')
        })

        it('should silently drop cells with non-existent fieldId', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [
                    [
                        { fieldId: field.id, value: 'valid' },
                        { fieldId: apId(), value: 'invalid' },
                    ],
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.length).toBe(1)
            expect(body[0].cells[field.id].value).toBe('valid')
        })
    })

    describeWithAuth('GET /v1/records (List)', () => app!, (setup) => {
        it('should list records for a table', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const record2 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [record1, record2])

            const response = await ctx.get('/v1/records', {
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(2)
        })

        it('should respect limit parameter', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const records = Array.from({ length: 3 }, () =>
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
            )
            await db.save('record', records)

            const response = await ctx.get('/v1/records', {
                tableId: table.id,
                limit: '2',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(2)
        })

        it('returns every column when no projection is asked for', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            for (const [fieldId, value] of [[name.id, 'Ada'], [phone.id, '+998900000000']] as const) {
                const cell = createMockCell({ recordId: record.id, fieldId, projectId: ctx.project.id })
                cell.value = value
                await db.save('cell', cell)
            }

            const response = await ctx.get('/v1/records', { tableId: table.id })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(Object.keys(body.data[0].cells).sort()).toEqual([name.id, phone.id].sort())
            expect(body.data[0].cells[phone.id].value).toBe('+998900000000')
        })

        it('returns only the projected columns, and not the names of the rest', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            for (const [fieldId, value] of [[name.id, 'Ada'], [phone.id, '+998900000000']] as const) {
                const cell = createMockCell({ recordId: record.id, fieldId, projectId: ctx.project.id })
                cell.value = value
                await db.save('cell', cell)
            }

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, fieldIds: [name.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(Object.keys(body.data[0].cells)).toEqual([name.id])
            expect(JSON.stringify(body)).not.toContain('+998900000000')
            expect(JSON.stringify(body)).not.toContain(phone.name)
        })

        it('back-fills a null only for a projected column that has no cell', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, fieldIds: [name.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(Object.keys(body.data[0].cells)).toEqual([name.id])
            expect(body.data[0].cells[name.id].value).toBeNull()
        })

        it('rejects a projection naming a column the table does not have', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            await db.save('record', createMockRecord({ tableId: table.id, projectId: ctx.project.id }))

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, fieldIds: [apId()] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        // `qs` drops an empty array entirely, so `fieldIds: []` is indistinguishable
        // from "no projection" on the wire. The reachable shape is a blank entry,
        // and that must not widen the read back to every column either.
        it('rejects a blank column id rather than reading it as every column', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, fieldIds: [''] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('returns only the records named by recordIds', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const wanted = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'wanted' })
            // More rows than ids asked for, deliberately: with one row per id the
            // limit slice alone produces the right count, and the test passes with
            // the id restriction deleted.
            for (const value of ['other-1', 'other-2', 'other-3', 'other-4']) {
                await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value })
            }

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, recordIds: [wanted.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.map((record: { id: string }) => record.id)).toEqual([wanted.id])
        })

        // qs drops an empty array, so the reachable "empty" shape is a blank entry.
        // It must restrict to nothing, never degrade to "no restriction".
        it('returns nothing for a blank recordId rather than every record', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'present' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, recordIds: [''] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().data).toEqual([])
        })

        // limit defaults to 10, so without this a lookup of more ids than that
        // would silently come back short.
        it('does not truncate a recordIds lookup to the default page size', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const records = []
            for (let index = 0; index < 12; index++) {
                records.push(await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: `row-${index}` }))
            }
            // Rows the lookup must NOT return, so a missing id restriction cannot
            // satisfy the count by accident.
            for (const value of ['extra-1', 'extra-2', 'extra-3']) {
                await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value })
            }

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, recordIds: records.map((record) => record.id) })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const returned = response?.json().data.map((record: { id: string }) => record.id).sort()
            expect(returned).toEqual(records.map((record) => record.id).sort())
        })

        it('ignores a recordId belonging to another table rather than returning it', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const wanted = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'wanted' })
            const otherTable = createMockTable({ projectId: ctx.project.id })
            await db.save('table', otherTable)
            const foreign = createMockRecord({ tableId: otherTable.id, projectId: ctx.project.id })
            await db.save('record', foreign)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, recordIds: [wanted.id, foreign.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.map((record: { id: string }) => record.id)).toEqual([wanted.id])
        })

        it('should return empty data for table with no records', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.get('/v1/records', {
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(0)
        })
    })

    describeWithAuth('GET /v1/records/:id (Get by ID)', () => app!, (setup) => {
        it('should return populated record by ID', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
            cell.value = 'cell-value'
            await db.save('cell', cell)

            const response = await ctx.get(`/v1/records/${record.id}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.id).toBe(record.id)
            expect(body.cells[field.id]).toBeDefined()
            expect(body.cells[field.id].value).toBe('cell-value')
            expect(body.cells[field.id].fieldName).toBe(field.name)
        })

        it('should return 404 for non-existent ID', async () => {
            const ctx = await setup()

            const response = await ctx.get(`/v1/records/${apId()}`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('returns only the projected columns', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            for (const [fieldId, value] of [[name.id, 'Ada'], [phone.id, '+998900000000']] as const) {
                const cell = createMockCell({ recordId: record.id, fieldId, projectId: ctx.project.id })
                cell.value = value
                await db.save('cell', cell)
            }

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records/${record.id}?${qs.stringify({ fieldIds: [name.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(Object.keys(body.cells)).toEqual([name.id])
            expect(JSON.stringify(body)).not.toContain('+998900000000')
        })

        it('rejects a projection naming a column of another table', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            const otherTable = createMockTable({ projectId: ctx.project.id })
            await db.save('table', otherTable)
            const otherField = createMockField({ tableId: otherTable.id, projectId: ctx.project.id })
            otherField.type = FieldType.TEXT
            await db.save('field', otherField)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records/${record.id}?${qs.stringify({ fieldIds: [otherField.id] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/:id (Update)', () => app!, (setup) => {
        it('should update cell value', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
            cell.value = 'old-value'
            await db.save('cell', cell)

            const response = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [
                    { fieldId: field.id, value: 'new-value' },
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.cells[field.id].value).toBe('new-value')
        })

        it('should add new cell to existing record (upsert)', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const field2 = createMockField({ tableId: table.id, projectId: ctx.project.id })
            field2.type = FieldType.TEXT
            await db.save('field', field2)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)

            const response = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [
                    { fieldId: field2.id, value: 'new-cell-value' },
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.cells[field2.id].value).toBe('new-cell-value')
        })

        it('should return 404 for non-existent record', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.post(`/v1/records/${apId()}`, {
                tableId: table.id,
                cells: [],
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describeWithAuth('GET /v1/records (List with filters)', () => app!, (setup) => {
        it('EXISTS: should match record with non-empty cell', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const record2 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [record1, record2])
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = 'hello'
            await db.save('cell', cell1)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(record1.id)
        })

        it('EXISTS: should not match record with empty string cell', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record1)
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = ''
            await db.save('cell', cell1)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(0)
        })

        it('NOT_EXISTS: should match record without a cell for the field', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const record2 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [record1, record2])
            const cell2 = createMockCell({ recordId: record2.id, fieldId: field.id, projectId: ctx.project.id })
            cell2.value = 'hello'
            await db.save('cell', cell2)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(record1.id)
        })

        it('NOT_EXISTS: should match record with empty string cell', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record1)
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = ''
            await db.save('cell', cell1)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(record1.id)
        })

        it('NOT_EXISTS: should exclude record with non-empty cell', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record1)
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = 'filled'
            await db.save('cell', cell1)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(0)
        })

        it('EQ: should match record with matching value', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const record2 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [record1, record2])
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = 'target'
            const cell2 = createMockCell({ recordId: record2.id, fieldId: field.id, projectId: ctx.project.id })
            cell2.value = 'other'
            await db.save('cell', [cell1, cell2])

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.EQ, value: 'target' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(record1.id)
        })

        it('IN: should match records whose value is in the list', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const records = [
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
            ]
            await db.save('record', records)
            const cells = records.map((record, i) => {
                const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
                cell.value = ['a', 'b', 'c'][i]
                return cell
            })
            await db.save('cell', cells)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.IN, value: ['a', 'c'] }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.map((r: { id: string }) => r.id).sort()).toEqual([records[0].id, records[2].id].sort())
        })

        it('NOT_IN: should exclude records whose value is in the list', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const records = [
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
                createMockRecord({ tableId: table.id, projectId: ctx.project.id }),
            ]
            await db.save('record', records)
            const cells = records.map((record, i) => {
                const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
                cell.value = ['a', 'b', 'c'][i]
                return cell
            })
            await db.save('cell', cells)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.NOT_IN, value: ['a', 'c'] }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(records[1].id)
        })

        it('IN: a bare single value (no array index) is coerced to a one-item list', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record1 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const record2 = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [record1, record2])
            const cell1 = createMockCell({ recordId: record1.id, fieldId: field.id, projectId: ctx.project.id })
            cell1.value = 'only'
            const cell2 = createMockCell({ recordId: record2.id, fieldId: field.id, projectId: ctx.project.id })
            cell2.value = 'other'
            await db.save('cell', [cell1, cell2])

            // `value: 'only'` (a plain string, not an array) exercises the
            // coerceToStringArray `[String(v)]` fallback path.
            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.IN, value: 'only' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(record1.id)
        })

        it('IN: an empty value list is rejected', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.IN, value: [] }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('NOT_IN: excludes a record that has no cell for the field (outer guard)', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const withCell = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const withoutCell = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [withCell, withoutCell])
            const cell = createMockCell({ recordId: withCell.id, fieldId: field.id, projectId: ctx.project.id })
            cell.value = 'kept'
            await db.save('cell', cell)

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.NOT_IN, value: ['excluded'] }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(withCell.id)
        })

        it('rejects a filter naming a field that is not a column of the table', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const otherTable = createMockTable({ projectId: ctx.project.id })
            await db.save('table', otherTable)
            const otherField = createMockField({ tableId: otherTable.id, projectId: ctx.project.id })
            otherField.type = FieldType.TEXT
            await db.save('field', otherField)
            await db.save('record', createMockRecord({ tableId: table.id, projectId: ctx.project.id }))

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: otherField.id, operator: FilterOperator.EQ, value: 'demo' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('NOT_EXISTS on a field of another table does not return the whole table', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const otherTable = createMockTable({ projectId: ctx.project.id })
            await db.save('table', otherTable)
            const otherField = createMockField({ tableId: otherTable.id, projectId: ctx.project.id })
            otherField.type = FieldType.TEXT
            await db.save('field', otherField)
            await db.save('record', createMockRecord({ tableId: table.id, projectId: ctx.project.id }))

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: otherField.id, operator: FilterOperator.NOT_EXISTS }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('LT on a DATE field matches a cell earlier the same day', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.DATE })
            const inWindow = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: '2026-09-10T09:00:00Z' })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: '2026-09-12T09:00:00Z' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.LT, value: '2026-09-11T00:00:00Z' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(inWindow.id)
        })

        it('GTE on a DATE field does not match every row of the same year', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.DATE })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: '2026-01-01T00:00:00Z' })
            const onOrAfter = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: '2026-12-31T23:59:59Z' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.GTE, value: '2026-12-31T23:59:59Z' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(onOrAfter.id)
        })

        it('GT on a TEXT field compares lexicographically', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const later = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'Beta' })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'Alpha' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.GT, value: 'B' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(later.id)
        })

        it('rejects a range value the column type cannot interpret', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.DATE })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: '2026-09-10T09:00:00Z' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.GT, value: 'yesterday' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        // A binding that resolves to an empty string is the ordinary way to get
        // here, and an empty cell is excluded from ordering — so accepting it
        // would make gte match every row with a non-empty cell.
        it('rejects a blank range value on a TEXT column instead of matching every row', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'Alpha' })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'Beta' })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.GTE, value: '' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('a projection does not weaken a filter on a column it does not include', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)

            const listed = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            const unlisted = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', [listed, unlisted])
            const listedPhone = createMockCell({ recordId: listed.id, fieldId: phone.id, projectId: ctx.project.id })
            listedPhone.value = '+998900000000'
            await db.save('cell', listedPhone)
            for (const [record, value] of [[listed, 'Listed'], [unlisted, 'Unlisted']] as const) {
                const cell = createMockCell({ recordId: record.id, fieldId: name.id, projectId: ctx.project.id })
                cell.value = value
                await db.save('cell', cell)
            }

            // Narrowing the cell query to the projection alone would leave this
            // filter with no cell to test, which the missing-cell guard reads as
            // a match for NOT_EXISTS — the whole table.
            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({
                    tableId: table.id,
                    fieldIds: [name.id],
                    filters: [{ fieldId: phone.id, operator: FilterOperator.NOT_EXISTS }],
                })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(body.data[0].id).toBe(unlisted.id)
            expect(Object.keys(body.data[0].cells)).toEqual([name.id])
        })

        // The union fetches the filtered column's cell, so it is genuinely present
        // on the record at format time — which is the only case that exercises the
        // reducer's projection guard. The filter is usually where the sensitive
        // column is, so a cell that arrives this way must not reach the output.
        it('drops a filtered-on column from the output when it is not projected', async () => {
            const ctx = await setup()
            const { table, field: name } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const phone = createMockField({ tableId: table.id, projectId: ctx.project.id })
            phone.type = FieldType.TEXT
            await db.save('field', phone)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            for (const [fieldId, value] of [[name.id, 'Ada'], [phone.id, '+998900000000']] as const) {
                const cell = createMockCell({ recordId: record.id, fieldId, projectId: ctx.project.id })
                cell.value = value
                await db.save('cell', cell)
            }

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({
                    tableId: table.id,
                    fieldIds: [name.id],
                    filters: [{ fieldId: phone.id, operator: FilterOperator.EQ, value: '+998900000000' }],
                })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.data.length).toBe(1)
            expect(Object.keys(body.data[0].cells)).toEqual([name.id])
            expect(JSON.stringify(body)).not.toContain('+998900000000')
        })

        it('rejects an uninterpretable range value even when the table is empty', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.NUMBER })

            const response = await ctx.inject({
                method: 'GET',
                url: `/api/v1/records?${qs.stringify({ tableId: table.id, filters: [{ fieldId: field.id, operator: FilterOperator.GT, value: 'ten' }] })}`,
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/upsert', () => app!, (setup) => {
        it('inserts when the key is new and updates when it is not', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const note = createMockField({ tableId: table.id, projectId: ctx.project.id })
            note.type = FieldType.TEXT
            await db.save('field', note)

            const first = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'user-1' }, { fieldId: note.id, value: 'first' }]],
            })
            expect(first?.statusCode).toBe(StatusCodes.OK)
            expect(first?.json()[0].action).toBe('created')

            const second = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'user-1' }, { fieldId: note.id, value: 'second' }]],
            })
            expect(second?.statusCode).toBe(StatusCodes.OK)
            expect(second?.json()[0].action).toBe('updated')
            expect(second?.json()[0].record.id).toBe(first?.json()[0].record.id)
            expect(second?.json()[0].record.cells[note.id].value).toBe('second')

            // The whole point: a repeat leaves one row, not two.
            const all = await ctx.get('/v1/records', { tableId: table.id })
            expect(all?.json().data.length).toBe(1)
        })

        // The scenario the ticket describes: the same inbound webhook delivered twice,
        // arriving at the same moment. Read-then-write lets both see "not seen yet".
        it('creates exactly one record when two identical upserts race', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })

            const body = {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'delivery-1' }]],
            }
            const [a, b] = await Promise.all([
                ctx.post('/v1/records/upsert', body),
                ctx.post('/v1/records/upsert', body),
            ])

            expect([a?.statusCode, b?.statusCode]).toEqual([StatusCodes.OK, StatusCodes.OK])
            const actions = [a?.json()[0].action, b?.json()[0].action].sort()
            expect(actions).toEqual(['created', 'updated'])

            const all = await ctx.get('/v1/records', { tableId: table.id })
            expect(all?.json().data.length).toBe(1)
        })

        it('matches an absent cell and an empty cell as the same key', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const other = createMockField({ tableId: table.id, projectId: ctx.project.id })
            other.type = FieldType.TEXT
            await db.save('field', other)
            // create strips empty values, so this row has no cell for `other` at all.
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            const cell = createMockCell({ recordId: record.id, fieldId: key.id, projectId: ctx.project.id })
            cell.value = 'k'
            await db.save('cell', cell)

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id, other.id],
                records: [[{ fieldId: key.id, value: 'k' }, { fieldId: other.id, value: '' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json()[0].action).toBe('updated')
        })

        it('rejects a record that does not set every key column', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const other = createMockField({ tableId: table.id, projectId: ctx.project.id })
            other.type = FieldType.TEXT
            await db.save('field', other)

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id, other.id],
                records: [[{ fieldId: key.id, value: 'k' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('inserts a batch larger than one statement can carry', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const extra: { id: string }[] = []
            for (let index = 0; index < 59; index++) {
                const column = createMockField({ tableId: table.id, projectId: ctx.project.id })
                column.type = FieldType.TEXT
                await db.save('field', column)
                extra.push(column)
            }

            // 250 rows x 60 columns = 15,000 cells, and a cell row binds 5 parameters:
            // 75,000 against Postgres' 65,535 per statement. Unchunked, the single
            // INSERT dies with an 08P01 and takes the transaction with it — on a batch
            // size UpsertRecordsRequest explicitly permits.
            const records = Array.from({ length: 250 }, (_, index) => [
                { fieldId: key.id, value: `key-${index}` },
                ...extra.map((column) => ({ fieldId: column.id, value: `v-${index}` })),
            ])

            const response = await ctx.post('/v1/records/upsert', { tableId: table.id, keyFieldIds: [key.id], records })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().length).toBe(250)
            expect(response?.json().every((result: { action: string }) => result.action === 'created')).toBe(true)
        })

        it('rejects a key column that is not a column of the table', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [apId()],
                records: [[{ fieldId: field.id, value: 'k' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects the same column set twice inside one record', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'k' }, { fieldId: key.id, value: 'other' }]],
            })

            // Two rows with one conflict target in a single statement; Postgres answers
            // that with a 500 on a body UpsertRecordsRequest accepts.
            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects the same column twice when the key already exists', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: key.id, value: 'k' })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'k' }, { fieldId: key.id, value: 'other' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects a key repeated inside one batch', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'same' }], [{ fieldId: key.id, value: 'same' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('refuses to guess when the key already matches two records', async () => {
            const ctx = await setup()
            const { table, field: key } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            for (const _ of [0, 1]) {
                await createRecordWithCell({ ctx, tableId: table.id, fieldId: key.id, value: 'dup' })
            }

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [key.id],
                records: [[{ fieldId: key.id, value: 'dup' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/:id (Conditional update)', () => app!, (setup) => {
        // "Record the check-in timestamp only on the first check-in" — an ordinary
        // business rule that was three steps and a race before this.
        it('applies when the condition holds and refuses when it does not', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)

            const first = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [{ fieldId: field.id, value: 'first-writer' }],
                precondition: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }],
            })
            expect(first?.statusCode).toBe(StatusCodes.OK)
            expect(first?.json().cells[field.id].value).toBe('first-writer')

            const second = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [{ fieldId: field.id, value: 'second-writer' }],
                precondition: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }],
            })
            expect(second?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(second?.json().code).toBe('RECORD_PRECONDITION_FAILED')

            // Refused, not silently skipped: the first writer's value survives.
            const stored = await ctx.get(`/v1/records/${record.id}`)
            expect(stored?.json().cells[field.id].value).toBe('first-writer')
        })

        it('lets exactly one of two concurrent conditional updates win', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)

            const body = (value: string) => ({
                tableId: table.id,
                cells: [{ fieldId: field.id, value }],
                precondition: [{ fieldId: field.id, operator: FilterOperator.NOT_EXISTS }],
            })
            const [a, b] = await Promise.all([
                ctx.post(`/v1/records/${record.id}`, body('a')),
                ctx.post(`/v1/records/${record.id}`, body('b')),
            ])

            // Without the row lock both return 200 and one write is silently lost.
            expect([a?.statusCode, b?.statusCode].sort()).toEqual([StatusCodes.OK, StatusCodes.CONFLICT].sort())
        })

        it('applies when an expected value still matches', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const record = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'pending' })

            const response = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [{ fieldId: field.id, value: 'done' }],
                precondition: [{ fieldId: field.id, operator: FilterOperator.EQ, value: 'pending' }],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().cells[field.id].value).toBe('done')
        })

        it('leaves the record untouched when an unconditional update would have applied', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.TEXT })
            const record = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'pending' })

            const response = await ctx.post(`/v1/records/${record.id}`, {
                tableId: table.id,
                cells: [{ fieldId: field.id, value: 'done' }],
                precondition: [{ fieldId: field.id, operator: FilterOperator.EQ, value: 'something-else' }],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            const stored = await ctx.get(`/v1/records/${record.id}`)
            expect(stored?.json().cells[field.id].value).toBe('pending')
        })
    })

    describeWithAuth('POST /v1/records/batch (Update many)', () => app!, (setup) => {
        it('updates every record in one request', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const first = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })
            const second = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [
                    { id: first.id, cells: [{ fieldId: field.id, value: 'after-1' }] },
                    { id: second.id, cells: [{ fieldId: field.id, value: 'after-2' }] },
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.length).toBe(2)
            // In request order, not created order: create-records returns in input
            // order, so a flow indexing step.output[i] must not be right there and
            // silently wrong here.
            expect(body.map((record: { id: string }) => record.id)).toEqual([first.id, second.id])
            expect(body.map((record: { cells: Record<string, { value: string }> }) => record.cells[field.id].value)).toEqual(['after-1', 'after-2'])
        })

        it('creates no record and writes no cell when one id is unknown', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const existing = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [
                    { id: existing.id, cells: [{ fieldId: field.id, value: 'after' }] },
                    { id: apId(), cells: [{ fieldId: field.id, value: 'after' }] },
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)

            // The whole batch rolls back rather than half-applying.
            const unchanged = await ctx.get(`/v1/records/${existing.id}`)
            expect(unchanged?.json().cells[field.id].value).toBe('before')
        })

        it('refuses to update a record that belongs to another table', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const otherTable = createMockTable({ projectId: ctx.project.id })
            await db.save('table', otherTable)
            const foreign = createMockRecord({ tableId: otherTable.id, projectId: ctx.project.id })
            await db.save('record', foreign)

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [{ id: foreign.id, cells: [{ fieldId: field.id, value: 'after' }] }],
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        // Postgres raises "cannot affect row a second time" for these, which would
        // surface as a 500 rather than a readable rejection.
        it('rejects a record id repeated in the batch', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [
                    { id: record.id, cells: [{ fieldId: field.id, value: 'a' }] },
                    { id: record.id, cells: [{ fieldId: field.id, value: 'b' }] },
                ],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects the same column set twice inside one record', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [{ id: record.id, cells: [{ fieldId: field.id, value: 'a' }, { fieldId: field.id, value: 'b' }] }],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects an empty batch', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.post('/v1/records/batch', { tableId: table.id, records: [] })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('drops a cell whose column is not in the table, as the single-record path does', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            const record = await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'before' })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [{ id: record.id, cells: [{ fieldId: field.id, value: 'after' }, { fieldId: apId(), value: 'ignored' }] }],
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json()[0].cells[field.id].value).toBe('after')
        })
    })

    describeWithAuth('DELETE /v1/records (Delete)', () => app!, (setup) => {
        it('should delete records by IDs', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)

            const response = await ctx.inject({
                method: 'DELETE',
                url: '/api/v1/records',
                body: {
                    tableId: table.id,
                    ids: [record.id],
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const getResponse = await ctx.get(`/v1/records/${record.id}`)
            expect(getResponse?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('should return 404 when record does not exist', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.inject({
                method: 'DELETE',
                url: '/api/v1/records',
                body: {
                    tableId: table.id,
                    ids: [apId()],
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })
})

async function createTableWithField(ctx: TestContext) {
    return createTableWithTypedField({ ctx, type: FieldType.TEXT })
}

async function createTableWithTypedField({ ctx, type }: { ctx: TestContext, type: FieldType }) {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
    field.type = type
    await db.save('field', field)
    return { table, field }
}

async function createRecordWithCell({ ctx, tableId, fieldId, value }: { ctx: TestContext, tableId: string, fieldId: string, value: string }) {
    const record = createMockRecord({ tableId, projectId: ctx.project.id })
    await db.save('record', record)
    const cell = createMockCell({ recordId: record.id, fieldId, projectId: ctx.project.id })
    cell.value = value
    await db.save('cell', cell)
    return record
}

import { FieldType, MAX_KEY_FIELDS } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import { createMockField, createMockTable } from '../../../helpers/mocks'
import { TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Table key declaration (#409)', () => {

    describeWithAuth('POST /v1/tables/:id/key — declare', () => app!, (setup) => {
        it('declares a key on an empty table', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().keyFieldIds).toEqual([field.id])
        })

        it('backfills keyValue for every existing record and declares the key', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'a' })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'b' })

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            expect(response?.statusCode).toBe(StatusCodes.OK)

            const records = await db.find<{ keyValue: string | null }>('record', { tableId: table.id })
            expect(records.every((record) => record.keyValue !== null)).toBe(true)
            expect(new Set(records.map((record) => record.keyValue)).size).toBe(2)
        })

        it('rejects declaring a key when two existing records already collide on it, without listing the collision', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'same' })
            await createRecordWithCell({ ctx, tableId: table.id, fieldId: field.id, value: 'same' })

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            const body = response?.json()
            expect(JSON.stringify(body)).not.toContain('same')

            const reread = await ctx.get(`/v1/tables/${table.id}`)
            expect(reread?.json().keyFieldIds).toBeNull()
        })

        it('rejects a key field that does not belong to the table', async () => {
            const ctx = await setup()
            const { table } = await createTableWithField(ctx)

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: ['nonexistent-field'] })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('clears a key when keyFieldIds is empty', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [] })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().keyFieldIds).toBeNull()
        })
    })

    describeWithAuth('POST /v1/records — unique enforcement once a key is declared', () => app!, (setup) => {
        it('rejects a second record with the same key value', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'dup' }]] })
            expect(first?.statusCode).toBe(StatusCodes.CREATED)

            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'dup' }]] })

            expect(second?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(second?.json().code).toBe('RECORD_DUPLICATE_KEY')
        })

        it('allows two records with different key values', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'a' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'b' }]] })

            expect(first?.statusCode).toBe(StatusCodes.CREATED)
            expect(second?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('does not enforce uniqueness when no key is declared', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'dup' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'dup' }]] })

            expect(first?.statusCode).toBe(StatusCodes.CREATED)
            expect(second?.statusCode).toBe(StatusCodes.CREATED)
        })
    })

    describeWithAuth('records with no key value at all', () => app!, (setup) => {
        // The grid's "+" button posts a record with zero cells. Deriving a real key value
        // from that (the all-empty tuple) puts the row INSIDE the partial index, so the
        // second blank row on a keyed table collides and the web write queue drops it
        // without telling anyone. A record whose key columns were never written has no key.
        it('lets more than one record exist with every key column empty', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[]] })

            expect(first?.statusCode).toBe(StatusCodes.CREATED)
            expect(second?.statusCode).toBe(StatusCodes.CREATED)
            const records = await db.find<{ keyValue: string | null }>('record', { tableId: table.id })
            expect(records.map((record) => record.keyValue)).toEqual([null, null])
        })

        it('treats an explicitly empty key cell the same as an absent one', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: '' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[]] })

            expect(first?.statusCode).toBe(StatusCodes.CREATED)
            expect(second?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('puts a record back outside the index when its key cell is cleared', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            const created = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'k' }]] })
            const recordId = created?.json()[0].id

            const response = await ctx.post(`/v1/records/${recordId}`, { tableId: table.id, cells: [{ fieldId: field.id, value: '' }] })
            expect(response?.statusCode).toBe(StatusCodes.OK)

            const after = await db.findOneBy<{ keyValue: string | null }>('record', { id: recordId })
            expect(after?.keyValue).toBeNull()
        })

        // A btree index entry cannot exceed 2704 bytes, and a cell value is unbounded. An
        // over-long key used to raise Postgres 54000 — which is not 23505, so nothing
        // mapped it and it surfaced as a 500.
        it('accepts a key value far larger than a btree index entry', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const longValue = 'x'.repeat(8000)
            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: longValue }]] })
            const duplicate = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: longValue }]] })

            expect(first?.statusCode).toBe(StatusCodes.CREATED)
            expect(duplicate?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('clearing and re-declaring a key', () => app!, (setup) => {
        // clearKey used to leave record.keyValue populated. The index is partial on
        // `WHERE keyValue IS NOT NULL` and does NOT consult table.keyFieldIds, so those
        // stale entries stayed live: edit the rows while unkeyed, re-declare, and the
        // row-at-a-time backfill walks into a 23505 the pre-scan had just approved — a
        // raw 500 on a legitimate operation.
        it('clears every record.keyValue along with the declaration', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'a' }]] })

            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [] })

            const records = await db.find<{ keyValue: string | null }>('record', { tableId: table.id })
            expect(records.map((record) => record.keyValue)).toEqual([null])
        })

        it('re-declares a key after the values were swapped while the table was unkeyed', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            const first = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'a' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'b' }]] })
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [] })

            await ctx.post(`/v1/records/${first?.json()[0].id}`, { tableId: table.id, cells: [{ fieldId: field.id, value: 'b' }] })
            await ctx.post(`/v1/records/${second?.json()[0].id}`, { tableId: table.id, cells: [{ fieldId: field.id, value: 'a' }] })

            const response = await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const records = await db.find<{ keyValue: string | null }>('record', { tableId: table.id })
            expect(new Set(records.map((record) => record.keyValue)).size).toBe(2)
        })
    })

    describeWithAuth('POST /v1/records/:id — unique enforcement on update', () => app!, (setup) => {
        it('rejects an update that would collide with another record\'s key', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'a' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'b' }]] })
            const secondId = second?.json()[0].id

            const response = await ctx.post(`/v1/records/${secondId}`, { tableId: table.id, cells: [{ fieldId: field.id, value: 'a' }] })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('leaves the key untouched when the update does not touch a key field', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const keyField = createMockField({ tableId: table.id, projectId: ctx.project.id })
            keyField.type = FieldType.TEXT
            await db.save('field', keyField)
            const otherField = createMockField({ tableId: table.id, projectId: ctx.project.id })
            otherField.type = FieldType.TEXT
            await db.save('field', otherField)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [keyField.id] })
            const created = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: keyField.id, value: 'k1' }]] })
            const recordId = created?.json()[0].id
            const before = await db.findOneBy<{ keyValue: string | null }>('record', { id: recordId })

            const response = await ctx.post(`/v1/records/${recordId}`, { tableId: table.id, cells: [{ fieldId: otherField.id, value: 'unrelated' }] })
            expect(response?.statusCode).toBe(StatusCodes.OK)

            const after = await db.findOneBy<{ keyValue: string | null }>('record', { id: recordId })
            expect(after?.keyValue).toBe(before?.keyValue)
        })
    })

    describeWithAuth('POST /v1/records/upsert — declared-key path', () => app!, (setup) => {
        it('creates on first upsert and updates on the second, matching the declared key', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const first = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [field.id],
                records: [[{ fieldId: field.id, value: 'k' }]],
            })
            expect(first?.statusCode).toBe(StatusCodes.OK)
            expect(first?.json()[0].action).toBe('created')

            const second = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [field.id],
                records: [[{ fieldId: field.id, value: 'k' }]],
            })
            expect(second?.statusCode).toBe(StatusCodes.OK)
            expect(second?.json()[0].action).toBe('updated')
            expect(second?.json()[0].record.id).toBe(first?.json()[0].record.id)

            const records = await db.find('record', { tableId: table.id })
            expect(records.length).toBe(1)
        })

        it('rejects an upsert whose keyFieldIds does not match the declared key', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const keyField = createMockField({ tableId: table.id, projectId: ctx.project.id })
            keyField.type = FieldType.TEXT
            await db.save('field', keyField)
            const otherField = createMockField({ tableId: table.id, projectId: ctx.project.id })
            otherField.type = FieldType.TEXT
            await db.save('field', otherField)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [keyField.id] })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [otherField.id],
                records: [[{ fieldId: keyField.id, value: 'k' }, { fieldId: otherField.id, value: 'v' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        // ON CONFLICT cannot arbitrate a null conflict target, so two such rows would both
        // insert. assertEveryRecordCarriesTheKey only proves the COLUMNS were sent.
        it('rejects an upsert whose key columns are all empty', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [field.id],
                records: [[{ fieldId: field.id, value: '' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/batch — unique enforcement on batch update', () => app!, (setup) => {
        it('rejects a batch update that would collide with another record\'s key', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'a' }]] })
            const second = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'b' }]] })

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [{ id: second?.json()[0].id, cells: [{ fieldId: field.id, value: 'a' }] }],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/tables/:id/key — request bounds', () => app!, (setup) => {
        // declareKey dedupes this array with the quadratic `unique()` as its very first
        // statement, before any database work — so an uncapped array blocks the whole
        // single-threaded API process rather than merely failing validation.
        it('rejects more key columns than MAX_KEY_FIELDS', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)

            const response = await ctx.post(`/v1/tables/${table.id}/key`, {
                keyFieldIds: Array.from({ length: MAX_KEY_FIELDS + 1 }, () => field.id),
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describeWithAuth('DELETE /v1/fields/:id — blocked while part of a declared key', () => app!, (setup) => {
        it('rejects deleting a field that is part of the table\'s declared key', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })

            const response = await ctx.delete(`/v1/fields/${field.id}`)

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            const stillThere = await db.findOneBy('field', { id: field.id })
            expect(stillThere).toBeDefined()
        })

        it('allows deleting the field once the key declaration is cleared', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithField(ctx)
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [field.id] })
            await ctx.post(`/v1/tables/${table.id}/key`, { keyFieldIds: [] })

            const response = await ctx.delete(`/v1/fields/${field.id}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })
    })
})

async function createTableWithField(ctx: TestContext) {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
    field.type = FieldType.TEXT
    await db.save('field', field)
    return { table, field }
}

async function createRecordWithCell({ ctx, tableId, fieldId, value }: { ctx: TestContext, tableId: string, fieldId: string, value: string }) {
    const response = await ctx.post('/v1/records', { tableId, records: [[{ fieldId, value }]] })
    return response?.json()[0]
}

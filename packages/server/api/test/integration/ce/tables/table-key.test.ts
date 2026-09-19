import { FieldType } from '@aiqadam/shared'
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

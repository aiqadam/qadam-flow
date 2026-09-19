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

describe('Cell write-time validation (#390)', () => {

    describeWithAuth('POST /v1/records — BOOLEAN', () => app!, (setup) => {
        it.each(['true', 'false', '', null])('accepts %s', async (value) => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.BOOLEAN })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
        })

        it.each(['TRUE', 'yes', '1', 'truex'])('rejects %s', async (value) => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.BOOLEAN })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/:id — BOOLEAN', () => app!, (setup) => {
        it('rejects an invalid value on update', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.BOOLEAN })
            const created = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'true' }]] })
            const recordId = created?.json()[0].id

            const response = await ctx.post(`/v1/records/${recordId}`, {
                tableId: table.id,
                cells: [{ fieldId: field.id, value: 'nope' }],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records — JSON', () => app!, (setup) => {
        it.each(['{"a":1}', '[]', '"str"', '5', 'true', 'null', '', null])('accepts %s', async (value) => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.JSON })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
        })

        it.each(['{invalid', '{"a":}', 'undefined'])('rejects invalid JSON %s', async (value) => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.JSON })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('stores the value verbatim as a string, not a parsed object', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.JSON })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: '{"a":1}' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            expect(response?.json()[0].cells[field.id].value).toBe('{"a":1}')
        })
    })

    describeWithAuth('POST /v1/records — JSON schema', () => app!, (setup) => {
        it('accepts a value that satisfies the declared schema', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createJsonFieldWithSchema({ ctx, tableId: table.id, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: '{"name":"Ada"}' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('rejects a value missing a required schema property', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createJsonFieldWithSchema({ ctx, tableId: table.id, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: '{"age":5}' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('rejects a value whose leaf type mismatches the schema', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createJsonFieldWithSchema({ ctx, tableId: table.id, schema: { type: 'object', properties: { age: { type: 'number' } } } })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: '{"age":"five"}' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records — STATIC_DROPDOWN', () => app!, (setup) => {
        it('accepts a value that is a declared option', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createDropdownField({ ctx, tableId: table.id, options: ['red', 'blue'] })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: 'red' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('accepts an empty value regardless of declared options', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createDropdownField({ ctx, tableId: table.id, options: ['red'] })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: '' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('rejects a value that is not a declared option', async () => {
            const ctx = await setup()
            const table = createMockTable({ projectId: ctx.project.id })
            await db.save('table', table)
            const field = await createDropdownField({ ctx, tableId: table.id, options: ['red', 'blue'] })

            const response = await ctx.post('/v1/records', {
                tableId: table.id,
                records: [[{ fieldId: field.id, value: 'green' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/batch — validation applies to updateMany', () => app!, (setup) => {
        it('rejects an invalid boolean cell in a batch update', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.BOOLEAN })
            const created = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'true' }]] })
            const recordId = created?.json()[0].id

            const response = await ctx.post('/v1/records/batch', {
                tableId: table.id,
                records: [{ id: recordId, cells: [{ fieldId: field.id, value: 'not-a-bool' }] }],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('POST /v1/records/upsert — validation applies', () => app!, (setup) => {
        it('rejects invalid JSON on upsert', async () => {
            const ctx = await setup()
            const { table, field } = await createTableWithTypedField({ ctx, type: FieldType.JSON })

            const response = await ctx.post('/v1/records/upsert', {
                tableId: table.id,
                keyFieldIds: [field.id],
                records: [[{ fieldId: field.id, value: '{broken' }]],
            })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })
})

async function createTableWithTypedField({ ctx, type }: { ctx: TestContext, type: FieldType }) {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
    field.type = type
    await db.save('field', field)
    return { table, field }
}

// `createMockField()` returns the `Field` union, and TypeScript will not let a write
// narrow which member's `data` shape applies — only TEXT/NUMBER/DATE/BOOLEAN even lack
// a `data` property at all. Building a fresh object literal (not mutating a
// `Field`-typed variable) sidesteps that: `db.save` is generic over its argument, not
// pinned to `Field`.
async function createJsonFieldWithSchema({ ctx, tableId, schema }: { ctx: TestContext, tableId: string, schema: unknown }) {
    const base = createMockField({ tableId, projectId: ctx.project.id })
    const field = { ...base, type: FieldType.JSON, data: { schema: JSON.stringify(schema) } }
    await db.save('field', field)
    return field
}

async function createDropdownField({ ctx, tableId, options }: { ctx: TestContext, tableId: string, options: string[] }) {
    const base = createMockField({ tableId, projectId: ctx.project.id })
    const field = { ...base, type: FieldType.STATIC_DROPDOWN, data: { options: options.map((value) => ({ value })) } }
    await db.save('field', field)
    return field
}

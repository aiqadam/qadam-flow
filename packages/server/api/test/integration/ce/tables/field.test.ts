import { apId, Cell, FieldType, isNil, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { apManageFieldsTool } from '../../../../src/app/mcp/tools/ap-manage-fields'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import {
    createMockCell,
    createMockField,
    createMockRecord,
    createMockTable,
} from '../../../helpers/mocks'
import { createTestContext, TestContext  } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Field API', () => {

    describeWithAuth('POST /v1/fields (Create)', () => app!, (setup) => {
        it('should create a TEXT field', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)

            const response = await ctx.post('/v1/fields', {
                name: 'Text Field',
                type: FieldType.TEXT,
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.name).toBe('Text Field')
            expect(body.type).toBe(FieldType.TEXT)
            expect(body.tableId).toBe(table.id)
            expect(body.id).toBeDefined()
            expect(body.externalId).toBeDefined()
        })

        it('should create a NUMBER field', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)

            const response = await ctx.post('/v1/fields', {
                name: 'Number Field',
                type: FieldType.NUMBER,
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.name).toBe('Number Field')
            expect(body.type).toBe(FieldType.NUMBER)
        })

        it('should create a DATE field', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)

            const response = await ctx.post('/v1/fields', {
                name: 'Date Field',
                type: FieldType.DATE,
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.name).toBe('Date Field')
            expect(body.type).toBe(FieldType.DATE)
        })

        it('should create a STATIC_DROPDOWN field with options', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)

            const response = await ctx.post('/v1/fields', {
                name: 'Dropdown Field',
                type: FieldType.STATIC_DROPDOWN,
                tableId: table.id,
                data: {
                    options: [
                        { value: 'Option A' },
                        { value: 'Option B' },
                    ],
                },
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.name).toBe('Dropdown Field')
            expect(body.type).toBe(FieldType.STATIC_DROPDOWN)
            expect(body.data.options).toEqual([
                { value: 'Option A' },
                { value: 'Option B' },
            ])
        })

        it('should create a field with custom externalId', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const externalId = apId()

            const response = await ctx.post('/v1/fields', {
                name: 'External Field',
                type: FieldType.TEXT,
                tableId: table.id,
                externalId,
            })

            expect(response?.statusCode).toBe(StatusCodes.CREATED)
            const body = response?.json()
            expect(body.externalId).toBe(externalId)
        })
    })

    describeWithAuth('GET /v1/fields (List)', () => app!, (setup) => {
        it('should list all fields for a table', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const field1 = createMockField({ tableId: table.id, projectId: ctx.project.id })
            const field2 = createMockField({ tableId: table.id, projectId: ctx.project.id })
            await db.save('field', [field1, field2])

            const response = await ctx.get('/v1/fields', {
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.length).toBe(2)
        })

        it('should return empty array for table with no fields', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)

            const response = await ctx.get('/v1/fields', {
                tableId: table.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.length).toBe(0)
        })
    })

    describeWithAuth('GET /v1/fields/:id (Get by ID)', () => app!, (setup) => {
        it('should return field by ID', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
            await db.save('field', field)

            const response = await ctx.get(`/v1/fields/${field.id}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.id).toBe(field.id)
            expect(body.name).toBe(field.name)
        })

        it('should return 404 for non-existent ID', async () => {
            const ctx = await setup()

            const response = await ctx.get(`/v1/fields/${apId()}`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describeWithAuth('POST /v1/fields/:id (Update)', () => app!, (setup) => {
        it('should update field name', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
            await db.save('field', field)

            const response = await ctx.post(`/v1/fields/${field.id}`, {
                name: 'Updated Field Name',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.name).toBe('Updated Field Name')
            expect(body.id).toBe(field.id)
        })
    })

    describeWithAuth('POST /v1/fields/:id — STATIC_DROPDOWN options in place (#842)', () => app!, (setup) => {
        it('adds an option and keeps the field id, externalId and existing cells', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            const created = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Open' }]] })
            const recordId = created?.json()[0].id

            const response = await ctx.post(`/v1/fields/${field.id}`, {
                data: { options: [{ value: 'Open' }, { value: 'Closed' }, { value: 'Archived' }] },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.id).toBe(field.id)
            expect(body.externalId).toBe(field.externalId)
            expect(body.name).toBe(field.name)
            expect(body.data.options).toEqual([{ value: 'Open' }, { value: 'Closed' }, { value: 'Archived' }])
            const cell = await db.findOneBy<Cell>('cell', { recordId, fieldId: field.id })
            expect(cell?.value).toBe('Open')
        })

        it('accepts a write of the newly added value, which was rejected before', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            const before = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Archived' }]] })
            expect(before?.statusCode).toBe(StatusCodes.CONFLICT)

            await ctx.post(`/v1/fields/${field.id}`, {
                data: { options: [{ value: 'Open' }, { value: 'Closed' }, { value: 'Archived' }] },
            })

            const after = await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Archived' }]] })
            expect(after?.statusCode).toBe(StatusCodes.CREATED)
        })

        it('keeps the options when only the name changes', async () => {
            const ctx = await setup()
            const { field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { name: 'Renamed' })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().name).toBe('Renamed')
            expect(response?.json().data.options).toEqual([{ value: 'Open' }, { value: 'Closed' }])
        })

        it('rejects removing an option that a record still holds, and changes nothing', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Closed' }]] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [{ value: 'Open' }] } })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            expect(JSON.stringify(response?.json())).not.toContain('Closed')
            const stored = await db.findOneBy<StoredField>('field', { id: field.id })
            expect(stored?.data).toEqual({ options: [{ value: 'Open' }, { value: 'Closed' }] })
        })

        it('rejects renaming an option that a record still holds (remove + add)', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Closed' }]] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [{ value: 'Open' }, { value: 'Done' }] } })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
        })

        it('removes an option that no record holds', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Open' }]] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [{ value: 'Open' }] } })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json().data.options).toEqual([{ value: 'Open' }])
        })

        it('ignores cells of another field when deciding whether an option is in use', async () => {
            const ctx = await setup()
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            const other = await createDropdownField({ ctx, options: ['Closed'], tableId: table.id })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: other.field.id, value: 'Closed' }]] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [{ value: 'Open' }] } })

            expect(response?.statusCode).toBe(StatusCodes.OK)
        })

        it('rejects an empty options list', async () => {
            const ctx = await setup()
            const { field } = await createDropdownField({ ctx, options: ['Open'] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [] } })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('rejects options on a field that is not a STATIC_DROPDOWN', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const created = await ctx.post('/v1/fields', { name: 'Notes', type: FieldType.TEXT, tableId: table.id })
            const textField = created?.json()

            const response = await ctx.post(`/v1/fields/${textField.id}`, { data: { options: [{ value: 'A' }] } })

            expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
            const stored = await db.findOneBy<StoredField>('field', { id: textField.id })
            expect(stored?.type).toBe(FieldType.TEXT)
            expect(stored?.data ?? null).toBeNull()
        })

        it('does not find a field of another project', async () => {
            const ctx = await setup()
            const otherCtx = await createTestContext(app!)
            const { field } = await createDropdownField({ ctx: otherCtx, options: ['Open'] })

            const response = await ctx.post(`/v1/fields/${field.id}`, { data: { options: [{ value: 'Open' }, { value: 'Closed' }] } })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            const stored = await db.findOneBy<StoredField>('field', { id: field.id })
            expect(stored?.data).toEqual({ options: [{ value: 'Open' }] })
        })
    })

    describe('ap_manage_fields UPDATE — options in place (#842)', () => {
        it('reports the options it added and keeps the field id and cells', async () => {
            const ctx = await createTestContext(app!)
            const { table, field } = await createDropdownField({ ctx, options: ['Open'] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Open' }]] })

            const result = await apManageFieldsTool(makeMcp(ctx.project.id), app!.log).execute({
                tableId: table.id,
                operation: 'UPDATE',
                fieldId: field.id,
                options: ['Open', 'Closed'],
            })

            const rendered = result.content.map((c) => ('text' in c ? c.text : '')).join('\n')
            expect(rendered).toContain('options added: ⟦Closed⟧')
            expect(rendered).not.toContain('Field renamed')
            expect(rendered).toContain(`id: ${field.id}`)
            const stored = await db.findOneBy<StoredField>('field', { id: field.id })
            expect(stored?.externalId).toBe(field.externalId)
            const cells = await db.find<Cell>('cell', { fieldId: field.id })
            expect(cells).toHaveLength(1)
        })

        it('surfaces the rejection when the removed option is still in use', async () => {
            const ctx = await createTestContext(app!)
            const { table, field } = await createDropdownField({ ctx, options: ['Open', 'Closed'] })
            await ctx.post('/v1/records', { tableId: table.id, records: [[{ fieldId: field.id, value: 'Closed' }]] })

            const result = await apManageFieldsTool(makeMcp(ctx.project.id), app!.log).execute({
                tableId: table.id,
                operation: 'UPDATE',
                fieldId: field.id,
                options: ['Open'],
            })

            expect(result.isError).toBe(true)
            const stored = await db.findOneBy<StoredField>('field', { id: field.id })
            expect(stored?.data).toEqual({ options: [{ value: 'Open' }, { value: 'Closed' }] })
        })
    })

    describeWithAuth('DELETE /v1/fields/:id (Delete)', () => app!, (setup) => {
        it('should delete field', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
            await db.save('field', field)

            const response = await ctx.delete(`/v1/fields/${field.id}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)

            const getResponse = await ctx.get(`/v1/fields/${field.id}`)
            expect(getResponse?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('should cascade delete cells for that field', async () => {
            const ctx = await setup()
            const table = await createAndSaveTable(ctx)
            const field = createMockField({ tableId: table.id, projectId: ctx.project.id })
            await db.save('field', field)
            const record = createMockRecord({ tableId: table.id, projectId: ctx.project.id })
            await db.save('record', record)
            const cell = createMockCell({ recordId: record.id, fieldId: field.id, projectId: ctx.project.id })
            await db.save('cell', cell)

            await ctx.delete(`/v1/fields/${field.id}`)

            const cellResult = await db.findOneBy('cell', { id: cell.id })
            expect(cellResult).toBeNull()
        })
    })
})

async function createDropdownField({ ctx, options, tableId }: { ctx: TestContext, options: string[], tableId?: string }) {
    const table = isNil(tableId) ? await createAndSaveTable(ctx) : { id: tableId }
    const response = await ctx.post('/v1/fields', {
        name: 'Status',
        type: FieldType.STATIC_DROPDOWN,
        tableId: table.id,
        data: { options: options.map((value) => ({ value })) },
    })
    expect(response?.statusCode).toBe(StatusCodes.CREATED)
    return { table, field: response?.json() }
}

function makeMcp(projectId: string): ProjectScopedMcpServer {
    return {
        id: apId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        projectId,
        platformId: null,
        type: McpServerType.PROJECT,
        token: apId(),
        disabledTools: null,
    }
}

async function createAndSaveTable(ctx: TestContext) {
    const table = createMockTable({ projectId: ctx.project.id })
    await db.save('table', table)
    return table
}

type StoredField = { type: FieldType, externalId: string, data: unknown }

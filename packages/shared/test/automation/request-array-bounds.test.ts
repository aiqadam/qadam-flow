import { z } from 'zod'
import { BulkCancelFlowRequestBody } from '../../src/lib/automation/flow-run/test-flow-run-request'
import { FlowOperationRequest, FlowOperationType } from '../../src/lib/automation/flows/operations'
import { CreateFieldRequest } from '../../src/lib/automation/tables/dto/fields.dto'
import { UpdateRecordRequest } from '../../src/lib/automation/tables/dto/records.dto'
import { CreateTableRequest } from '../../src/lib/automation/tables/dto/tables.dto'
import { FieldType } from '../../src/lib/automation/tables/field'
import { BoundedArray } from '../../src/lib/core/common/base-model'

describe('request array bounds', () => {
    it('caps the fields of a table create', () => {
        const field = { name: 'f', type: FieldType.TEXT, data: null, externalId: 'f' }

        expect(CreateTableRequest.safeParse({ projectId: 'p', name: 't', fields: [field] }).success).toBe(true)
        expect(tooBig(CreateTableRequest.safeParse({ projectId: 'p', name: 't', fields: Array(10_001).fill(field) }))).toBe(true)
    })

    it('caps the options of a dropdown field', () => {
        const request = (count: number): unknown => ({
            name: 'f',
            type: FieldType.STATIC_DROPDOWN,
            tableId: 't',
            data: { options: Array(count).fill({ value: 'a' }) },
        })

        expect(CreateFieldRequest.safeParse(request(10_000)).success).toBe(true)
        expect(CreateFieldRequest.safeParse(request(10_001)).success).toBe(false)
    })

    it('caps the preconditions of a single-record update', () => {
        const condition = { fieldId: 'f', operator: 'eq', value: 'x' }

        expect(UpdateRecordRequest.safeParse({ tableId: 't', precondition: Array(100).fill(condition) }).success).toBe(true)
        expect(tooBig(UpdateRecordRequest.safeParse({ tableId: 't', precondition: Array(101).fill(condition) }))).toBe(true)
    })

    it('caps the statuses of a bulk cancel', () => {
        const body = (count: number): unknown => ({ projectId: 'a'.repeat(21), status: Array(count).fill('PAUSED') })

        expect(BulkCancelFlowRequestBody.safeParse(body(10)).success).toBe(true)
        expect(tooBig(BulkCancelFlowRequestBody.safeParse(body(11)))).toBe(true)
    })

    it('rejects an unknown flow operation with one issue instead of one per operation', () => {
        const result = FlowOperationRequest.safeParse({ type: 'NOT_AN_OPERATION', request: {} })

        expect(result.error?.issues).toHaveLength(1)
        expect(result.error?.issues[0].path).toEqual(['type'])
    })

    it('parses a flow operation against its own variant only', () => {
        const result = FlowOperationRequest.safeParse({
            type: FlowOperationType.DELETE_ACTION,
            request: { names: Array(1000).fill(1) },
        })

        expect(result.error?.issues.map((issue) => issue.path)).toEqual([['request', 'names', 0]])
    })

    it('reports only the first invalid condition of a new branch', () => {
        const result = FlowOperationRequest.safeParse({
            type: FlowOperationType.ADD_BRANCH,
            request: { branchIndex: 0, stepName: 'router', branchName: 'b', conditions: Array(1000).fill(Array(1000).fill(1)) },
        })

        expect(result.error?.issues).toHaveLength(1)
    })

    it('supports an exact length and documents it', () => {
        const schema = BoundedArray({ element: z.number(), min: 3, max: 3 })

        expect(schema.safeParse([1, 2]).success).toBe(false)
        expect(schema.safeParse([1, 2, 3]).success).toBe(true)
        expect(schema.safeParse([1, 2, 3, 4]).success).toBe(false)
        expect(z.toJSONSchema(schema, { io: 'input' })).toMatchObject({ minItems: 3, maxItems: 3 })
    })
})

function tooBig(result: { success: boolean, error?: z.ZodError }): boolean {
    return result.error?.issues.length === 1 && result.error.issues[0].code === 'too_big'
}

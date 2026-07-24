import { z } from 'zod'
import { OptionalArrayFromQuery } from '../../../core/common/base-model'
import { Cursor } from '../../../core/common/seek-page'
import { formErrors } from '../../../form-errors'

const coerceToString = z.preprocess(
    (v) => (v === null || v === undefined ? v : String(v)),
    z.string().nullable(),
)

export const CreateRecordsRequest = z.object({
    records: z.array(z.array(z.object({
        fieldId: z.string(),
        value: coerceToString,
    }))),
    tableId: z.string(),
})

export type CreateRecordsRequest = z.infer<typeof CreateRecordsRequest>

export const UpdateRecordRequest = z.object({
    cells: z.array(z.object({
        fieldId: z.string(),
        value: coerceToString,
    })).optional(),
    tableId: z.string(),
    agentUpdate: z.boolean().optional(),
})

export type UpdateRecordRequest = z.infer<typeof UpdateRecordRequest>


export enum FilterOperator {
    EQ = 'eq',
    NEQ = 'neq',
    GT = 'gt',
    GTE = 'gte',
    LT = 'lt',
    LTE = 'lte',
    CO = 'co',
    IN = 'in',
    NOT_IN = 'not_in',
    EXISTS = 'exists',
    NOT_EXISTS = 'not_exists',
}

const coerceToStringArray = z.preprocess(
    // Query-string arrays arrive as a single string when only one value is
    // present, so normalise both shapes to a string[].
    (v) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)]),
    // An empty list would make `in` match nothing and `not_in` match everything —
    // almost always an unfilled value rather than intent, so reject it.
    z.array(z.string()).min(1, formErrors.required),
)

const valueFilter = <T extends FilterOperator>(op: T) => z.object({
    fieldId: z.string(),
    operator: z.literal(op),
    value: z.string(),
})

const listFilter = <T extends FilterOperator>(op: T) => z.object({
    fieldId: z.string(),
    operator: z.literal(op),
    value: coerceToStringArray,
})

const existenceFilter = <T extends FilterOperator>(op: T) => z.object({
    fieldId: z.string(),
    operator: z.literal(op),
})

export const Filter = z.discriminatedUnion('operator', [
    valueFilter(FilterOperator.EQ),
    valueFilter(FilterOperator.NEQ),
    valueFilter(FilterOperator.GT),
    valueFilter(FilterOperator.GTE),
    valueFilter(FilterOperator.LT),
    valueFilter(FilterOperator.LTE),
    valueFilter(FilterOperator.CO),
    listFilter(FilterOperator.IN),
    listFilter(FilterOperator.NOT_IN),
    existenceFilter(FilterOperator.EXISTS),
    existenceFilter(FilterOperator.NOT_EXISTS),
])

export type Filter = z.infer<typeof Filter>

export const ListRecordsRequest = z.object({
    tableId: z.string(),
    limit: z.coerce.number().optional(),
    cursor: z.string().optional(),
    filters: OptionalArrayFromQuery(Filter),
})

export type ListRecordsRequest = Omit<z.infer<typeof ListRecordsRequest>, 'cursor'> & { cursor: Cursor | undefined }

export const DeleteRecordsRequest = z.object({
    tableId: z.string(),
    ids: z.array(z.string()),
})

export type DeleteRecordsRequest = z.infer<typeof DeleteRecordsRequest>


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

// Bounded so an over-large batch fails with a readable 400 from the schema rather
// than a 413 from the body parser. Declared here rather than at the end of the file,
// against the usual convention, because the schema below consumes it while the module
// is being evaluated — moving it down is a TS2448 "used before its declaration".
export const MAX_RECORDS_PER_BATCH = 1000

// Same "declared here, not at the end" exception as above, but a much lower number,
// and not for the reason the batch cap has. `unique()` is O(n²) with a JSON.stringify
// per comparison, and the service dedupes this array before any validation runs — so
// this constant sizes a quadratic loop on the request path, not just a parse. Note the
// inversion that makes the tempting "generous cap" wrong: one id repeated is the CHEAP
// case (findIndex returns immediately); all-distinct is the expensive one, so the cost
// is paid by a request that is about to be rejected anyway. 200 keeps 2x headroom over
// MAX_FIELDS_PER_TABLE's default of 100 — no real business key is wider than a table —
// at roughly 1.5 ms against 100 ms for 1000.
export const MAX_KEY_FIELDS_PER_UPSERT = 200

export const UpdateRecordsRequest = z.object({
    tableId: z.string(),
    records: z.array(z.object({
        id: z.string(),
        cells: z.array(z.object({
            fieldId: z.string(),
            value: coerceToString,
        })),
    })).min(1, formErrors.required).max(MAX_RECORDS_PER_BATCH),
    agentUpdate: z.boolean().optional(),
})

export type UpdateRecordsRequest = z.infer<typeof UpdateRecordsRequest>


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

export const UpdateRecordRequest = z.object({
    cells: z.array(z.object({
        fieldId: z.string(),
        value: coerceToString,
    })).optional(),
    tableId: z.string(),
    agentUpdate: z.boolean().optional(),
    // Compare-and-set: the update applies only if the record still matches every
    // condition, evaluated inside the same transaction as the write. Reusing Filter
    // gives eq/neq/in/not_in and — the case the ticket names as "is empty" —
    // not_exists.
    precondition: z.array(Filter).min(1, formErrors.required).optional(),
})

export type UpdateRecordRequest = z.infer<typeof UpdateRecordRequest>

export const UpsertRecordsRequest = z.object({
    tableId: z.string(),
    // The business key to match on. Without it an upsert is just a create, so it is
    // required rather than defaulted to something. Capped because the service dedupes
    // this array before any validation runs and that dedupe is quadratic — see
    // MAX_KEY_FIELDS_PER_UPSERT. The bound that keeps the matching loop cheap is the
    // dedupe itself, which leaves at most as many ids as the table has columns.
    keyFieldIds: z.array(z.string()).min(1, formErrors.required).max(MAX_KEY_FIELDS_PER_UPSERT),
    records: z.array(z.array(z.object({
        fieldId: z.string(),
        value: coerceToString,
    }))).min(1, formErrors.required).max(MAX_RECORDS_PER_BATCH),
})

export type UpsertRecordsRequest = z.infer<typeof UpsertRecordsRequest>

// Which half of the upsert happened, per input row. The caller needs this to tell
// "I created it" from "it was already there", which is the whole point of asking.
export enum UpsertAction {
    CREATED = 'created',
    UPDATED = 'updated',
}

// Shared by `fieldIds` and `recordIds`. `undefined` survives as "not asked for".
// `.min(1)` is unreachable over a query string — qs drops an empty array entirely and
// a blank value preprocesses to `['']` — so what actually matters is that the
// reachable blank shape fails CLOSED: `fieldIds: ['']` is rejected by
// resolveProjectedFields, and `recordIds: ['']` restricts to an id that matches
// nothing. Neither degrades to "no restriction", which is the #382 fail-open shape.
const idListFromQuery = z.preprocess(
    (v) => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? undefined : [String(v)]),
    z.array(z.string()).min(1, formErrors.required).optional(),
)

export const ListRecordsRequest = z.object({
    tableId: z.string(),
    limit: z.coerce.number().optional(),
    cursor: z.string().optional(),
    filters: OptionalArrayFromQuery(Filter),
    fieldIds: idListFromQuery,
    recordIds: idListFromQuery,
})

export type ListRecordsRequest = Omit<z.infer<typeof ListRecordsRequest>, 'cursor'> & { cursor: Cursor | undefined }

export const GetRecordRequest = z.object({
    fieldIds: idListFromQuery,
})

export type GetRecordRequest = z.infer<typeof GetRecordRequest>

export const DeleteRecordsRequest = z.object({
    tableId: z.string(),
    ids: z.array(z.string()),
})

export type DeleteRecordsRequest = z.infer<typeof DeleteRecordsRequest>


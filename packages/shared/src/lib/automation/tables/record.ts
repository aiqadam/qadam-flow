import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../core/common'
import { Cell } from './cell'

export const Record = z.object({
    ...BaseModelSchema,
    tableId: z.string(),
    projectId: z.string(),
    // The materialised business-key value (#409) — derived from the table's declared
    // `keyFieldIds` the same way `buildKeyReader` derives it in record.service.ts, kept in
    // sync on every write that touches a key-field cell. `null` when the table has no
    // declared key, or before the record's key fields have ever been written. Enforced by
    // a partial unique index on `(projectId, tableId, keyValue)`, not by this schema.
    keyValue: Nullable(z.string()),
})

export type Record = z.infer<typeof Record>

export const PopulatedRecord = Record.extend({
    cells: z.record(z.string(), Cell.pick({ updated: true, created: true, value: true }).extend({
        fieldName: z.string(),
    })),
})

export type PopulatedRecord = z.infer<typeof PopulatedRecord>

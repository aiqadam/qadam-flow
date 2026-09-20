import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../core/common'
import { Cell } from './cell'

export const Record = z.object({
    ...BaseModelSchema,
    tableId: z.string(),
    projectId: z.string(),
    // The materialised business-key value (#409), kept in sync on every write that touches
    // a key-field cell and enforced by a partial unique index on
    // `(projectId, tableId, keyValue)` rather than by this schema. `null` when the table
    // has no declared key, and also when the record's own key columns are all empty — such
    // a record has no key and deliberately sits outside the index.
    //
    // Treat it as OPAQUE. It is a sha256 digest of the key columns' values (see
    // `tableKey.buildValueReader` in the server's `tables/record/key-reader.ts`), not a
    // readable tuple: a btree index entry cannot exceed 2704 bytes and a cell value is
    // unbounded. Two records share a key iff they share this value; nothing else about it
    // is contractual.
    keyValue: Nullable(z.string()),
})

export type Record = z.infer<typeof Record>

export const PopulatedRecord = Record.extend({
    cells: z.record(z.string(), Cell.pick({ updated: true, created: true, value: true }).extend({
        fieldName: z.string(),
    })),
})

export type PopulatedRecord = z.infer<typeof PopulatedRecord>

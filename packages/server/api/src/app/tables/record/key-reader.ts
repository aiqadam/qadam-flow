import { createHash } from 'node:crypto'
import { isNil } from '@aiqadam/shared'

// The one definition of "key" shared by every #409 write path: record.service.ts's
// create()/update()/updateMany()/upsert() and table.service.ts's declareKey backfill all
// derive their key through this object. Standalone (not exported from record.service.ts)
// so table.service.ts can use it too without an import cycle — record.service.ts already
// imports tableService, so tableService importing back from record.service.ts would be
// circular.
//
// Two readers, one derivation. `buildReader` returns the readable tuple and is what the
// legacy advisory-lock upsert matches on in memory and what error messages quote.
// `buildValueReader` returns what actually gets STORED in record.keyValue, and differs in
// the two ways storage forces:
//
//  - It returns null when every key component is empty. A record whose key columns have
//    never been written has no key to be unique on, and the partial index is
//    `WHERE keyValue IS NOT NULL` precisely so those rows sit outside it. Without this,
//    the grid's "add blank row" button materialises keyValue '["",""]' and the SECOND
//    blank row on a keyed table collides.
//  - It hashes. A btree index entry cannot exceed 2704 bytes, and a cell value is
//    unbounded — so a 3 KB paste into a keyed TEXT column would raise Postgres 54000
//    (not 23505, so nothing maps it) and surface as a 500. A sha256 digest is 64 chars
//    whatever the key is, and equality of digests is equality of tuples for every input
//    this will ever see.
//
// An absent cell and an empty cell are the same "empty", and both shapes really exist:
// the qadam actions strip empty values before posting, so a record with no value has no
// cell row at all, while the web grid and any raw API or MCP caller store a literal ''.
// Matching has to treat the two as equal, or two rows differing only in "cell present but
// empty" vs "cell absent" would collide on the same key value.
export const tableKey = {
    buildReader({ keyFieldIds }: BuildReaderParams): KeyReader {
        return (cells) => JSON.stringify(readKeyComponents({ keyFieldIds, cells }))
    },

    // The advisory-lock name both halves of the table-key lock agree on: writers take it
    // shared (record.service.ts), tableService.declareKey takes it exclusive. Namespaced
    // apart from `tables-upsert:` so the two locks stay independent, and always acquired
    // before it so there is one global order.
    lockName({ projectId, tableId }: { projectId: string, tableId: string }): string {
        return `tables-key:${projectId}:${tableId}`
    },

    buildValueReader({ keyFieldIds }: BuildReaderParams): KeyValueReader {
        return (cells) => {
            const components = readKeyComponents({ keyFieldIds, cells })
            if (components.every((component) => component === '')) {
                return null
            }
            return createHash('sha256').update(JSON.stringify(components)).digest('hex')
        }
    },
}

function readKeyComponents({ keyFieldIds, cells }: ReadKeyComponentsParams): string[] {
    return keyFieldIds.map((fieldId) => {
        const value = cells.find((cellData) => cellData.fieldId === fieldId)?.value
        return isNil(value) ? '' : String(value)
    })
}

type KeyCell = { fieldId: string, value: unknown }

type BuildReaderParams = { keyFieldIds: string[] }

type ReadKeyComponentsParams = { keyFieldIds: string[], cells: KeyCell[] }

export type KeyReader = (cells: KeyCell[]) => string

export type KeyValueReader = (cells: KeyCell[]) => string | null

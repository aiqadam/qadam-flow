import { isNil } from '@aiqadam/shared'

// The one definition of "key" shared by every #409 write path: record.service.ts's
// create()/update()/updateMany()/upsert() and table.service.ts's declareKey backfill
// all derive `record.keyValue` through this exact function. Standalone (not exported
// from record.service.ts) so table.service.ts can use it too without an import cycle —
// record.service.ts already imports tableService, so tableService importing back from
// record.service.ts would be circular.
//
// An absent cell and an empty cell are the same "empty", and both shapes really exist:
// the qadam actions strip empty values before posting, so a record with no value has
// no cell row at all, while the web grid and any raw API or MCP caller store a literal
// ''. Matching has to treat the two as equal, or two rows differing only in "cell
// present but empty" vs "cell absent" would collide on the same key value.
export function buildKeyReader({ keyFieldIds }: { keyFieldIds: string[] }): KeyReader {
    return (cells) => JSON.stringify(keyFieldIds.map((fieldId) => {
        const value = cells.find((cellData) => cellData.fieldId === fieldId)?.value
        return isNil(value) ? '' : String(value)
    }))
}

export type KeyReader = (cells: { fieldId: string, value: unknown }[]) => string

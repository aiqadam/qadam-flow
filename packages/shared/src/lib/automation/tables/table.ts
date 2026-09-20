import { z } from 'zod'
import { BaseModelSchema, Nullable, NullableEnum } from '../../core/common'
import { Field } from './field'

export enum TableAutomationTrigger {
    ON_NEW_RECORD = 'ON_NEW_RECORD',
    ON_UPDATE_RECORD = 'ON_UPDATE_RECORD',
}

export enum TableAutomationStatus {
    ENABLED = 'ENABLED',
    DISABLED = 'DISABLED',
}

export const Table = z.object({
    ...BaseModelSchema,
    name: z.string(),
    folderId: Nullable(z.string()),
    projectId: z.string(),
    externalId: z.string(),
    status: NullableEnum(TableAutomationStatus),
    trigger: NullableEnum(TableAutomationTrigger),
    // The declared business key (#409) — a field-id set whose materialised `record.keyValue`
    // is enforced by a partial unique index (`record(projectId, tableId, keyValue) WHERE
    // keyValue IS NOT NULL`). `null` until a table opts in via `POST /v1/tables/:id/key`.
    keyFieldIds: Nullable(z.array(z.string())),
})

export type Table = z.infer<typeof Table>


export const PopulatedTable = Table.extend({
    fields: z.array(Field),
})

export type PopulatedTable = z.infer<typeof PopulatedTable>

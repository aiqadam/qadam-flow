import { z } from 'zod'
import { Nullable } from '../../../core/common'
import { OptionalArrayFromQuery } from '../../../core/common/base-model'
import { formErrors } from '../../../form-errors'
import { FieldState } from '../../project-release/project-state'
import { TableAutomationStatus, TableAutomationTrigger } from '../table'
import { TableWebhookEventType } from '../table-webhook'
import { MAX_KEY_FIELDS } from './records.dto'

export const SAFE_EXTERNAL_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/

export const CreateTableRequest = z.object({
    projectId: z.string(),
    name: z.string(),
    fields: z.array(FieldState).optional(),
    externalId: z.string().regex(SAFE_EXTERNAL_ID_PATTERN, formErrors.invalidExternalId).optional(),
    folderId: z.string().optional(),
    folderName: z.string().optional(),
})

export type CreateTableRequest = z.infer<typeof CreateTableRequest>

export const ExportTableResponse = z.object({
    fields: z.array(z.object({ id: z.string(), name: z.string() })),
    rows: z.array(z.record(z.string(), z.string())),
    name: z.string(),
})

export type ExportTableResponse = z.infer<typeof ExportTableResponse>

export const CreateTableWebhookRequest = z.object({
    events: z.array(z.nativeEnum(TableWebhookEventType)),
    webhookUrl: z.string(),
    flowId: z.string(),
})

export type CreateTableWebhookRequest = z.infer<typeof CreateTableWebhookRequest>

export const UpdateTableRequest = z.object({
    name: z.string().optional(),
    trigger: z.nativeEnum(TableAutomationTrigger).optional(),
    status: z.nativeEnum(TableAutomationStatus).optional(),
    folderId: Nullable(z.string()),
})

export type UpdateTableRequest = z.infer<typeof UpdateTableRequest>


export const ListTablesRequest = z.object({
    projectId: z.string(),
    limit: z.coerce.number().optional(),
    cursor: z.string().optional(),
    name: z.string().optional(),
    externalIds: OptionalArrayFromQuery(z.string()),
    folderId: z.string().optional(),
    folderIds: OptionalArrayFromQuery(z.string()),
})

export type ListTablesRequest = z.infer<typeof ListTablesRequest>

export const CountTablesRequest = z.object({
    projectId: z.string(),
    folderId: z.string().optional(),
})

export type CountTablesRequest = z.infer<typeof CountTablesRequest>

// Declares (non-empty `keyFieldIds`) or clears (empty `keyFieldIds`) a table's business
// key (#409). Declaring runs a one-time collision scan over every existing record and
// backfills `record.keyValue`; from then on the partial unique index
// `record(projectId, tableId, keyValue) WHERE keyValue IS NOT NULL` enforces it. No
// `.min(1)` here — an empty array is the "clear the key" request, not an invalid one.
// Capped, though: `declareKey` dedupes this array with the quadratic `unique()` before any
// database work, so an uncapped array blocks the whole single-threaded API process. See
// MAX_KEY_FIELDS.
export const DeclareTableKeyRequest = z.object({
    keyFieldIds: z.array(z.string()).max(MAX_KEY_FIELDS),
})

export type DeclareTableKeyRequest = z.infer<typeof DeclareTableKeyRequest>

import {
    apId,
    chunk,
    CreateTableRequest,
    CreateTableWebhookRequest,
    ErrorCode,
    ExportTableResponse,
    formErrors,
    isNil,
    PopulatedTable,
    QadamFlowError,
    SeekPage,
    SharedTemplate,
    spreadIfDefined,
    Table,
    TableDataState,
    TableImportDataType,
    TableTemplate,
    TableWebhook,
    TableWebhookEventType,
    TemplateStatus,
    TemplateType,
    UncategorizedFolderId,
    unique,
    UpdateTableRequest,
    UserWithMetaInformation,
} from '@aiqadam/shared'
import { ArrayContains, EntityManager, ILike, In, IsNull } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { getFolderIdFromRequest } from '../../flows/flow/flow.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { system } from '../../helper/system/system'
import { fieldService } from '../field/field.service'
import { CellEntity } from '../record/cell.entity'
import { duplicateKeyError } from '../record/duplicate-key-error'
import { tableKey } from '../record/key-reader'
import { RecordEntity } from '../record/record.entity'
import { TableWebhookEntity } from './table-webhook.entity'
import { TableEntity } from './table.entity'

export const tableRepo = repoFactory(TableEntity)
export const recordRepo = repoFactory(RecordEntity)
const tableWebhookRepo = repoFactory(TableWebhookEntity)
const tablePieceName = '@aiqadam/qadam-tables'

// Bounds the caller-supplied id list echoed back in the "unknown key column" error —
// mirrors record.service.ts's own cap on the same message.
const MAX_REPORTED_FIELD_IDS = 10

// Matches record.service.ts's MAX_REPORTED_KEY_LENGTH: the count cap alone leaves each id
// unbounded, and ten unbounded ids are still an unbounded message.
const MAX_REPORTED_MESSAGE_LENGTH = 120

// Sized like record.service.ts's MAX_BATCH_SIZE is: large enough that a full
// MAX_RECORDS_PER_TABLE backfill is tens of round-trips rather than thousands, small
// enough that one statement's parameter arrays stay well inside the wire protocol's
// limits. The two arrays are passed whole, so the parameter COUNT is four regardless.
const KEY_BACKFILL_BATCH_SIZE = 500

export const tableService = {
    async create({
        projectId,
        request,
    }: CreateParams): Promise<Table> {
        const folderId = await getFolderIdFromRequest({ projectId, folderId: request.folderId, folderName: request.folderName, log: system.globalLogger() })
        const table = await tableRepo().save({
            id: apId(),
            externalId: request.externalId ?? apId(),
            name: request.name,
            projectId,
            folderId,
        })
        if (request.fields) {
            // Stamped per index rather than left to the column default: concurrent inserts commit in
            // an arbitrary order, and `fieldService.getAll` sorts on `created` with no tiebreaker, so
            // without this the caller's column order is not what they get back.
            const createdAt = Date.now()
            await Promise.all(request.fields.map(async (field, index) => {
                await fieldService.createFromState({ projectId, field, tableId: table.id, created: new Date(createdAt + index) })
            }))
        }
        return table
    },
    async list({ projectId, cursor, limit, name, externalIds, folderId, folderIds, includeRowCount }: ListParams): Promise<SeekPage<Table & { rowCount?: number }>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)

        const paginator = buildPaginator({
            entity: TableEntity,
            query: {
                limit,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const queryWhere: Record<string, unknown> = { projectId }
        if (!isNil(name)) {
            queryWhere.name = ILike(`%${name}%`)
        }
        if (!isNil(externalIds)) {
            queryWhere.externalId = In(externalIds)
        }

        if (!isNil(folderId)) {
            queryWhere.folderId = folderId === UncategorizedFolderId ? IsNull() : folderId
        }

        if (!isNil(folderIds)) {
            queryWhere.folderId = In(folderIds)
        }

        const queryBuilder = tableRepo().createQueryBuilder('table').where(queryWhere)

        if (includeRowCount) {
            queryBuilder.addSelect((subQuery) => {
                return subQuery
                    .select('COUNT(*)::int', 'rowCount')
                    .from('record', 'record')
                    .where('record."tableId" = table.id')
            }, 'rowCount')
        }

        const paginationResult = await paginator.paginate<Table & { rowCount?: number }>(queryBuilder)

        return paginationHelper.createPage(paginationResult.data, paginationResult.cursor)
    },

    async getOneOrThrow({
        projectId,
        id,
        entityManager,
    }: GetByIdParams): Promise<Table> {
        const table = await tableRepo(entityManager).findOne({
            where: { projectId, id },
        })
        if (isNil(table)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Table',
                    entityId: id,
                },
            })
        }
        return table
    },

    async getOneByExternalIdOrThrow({
        projectId,
        externalId,
    }: GetOneByExternalIdParams): Promise<Table> {
        const table = await tableRepo().findOneBy({ projectId, externalId })
        if (isNil(table)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Table',
                    entityId: externalId,
                },
            })
        }
        return table
    },

    async getOneByExternalIdOrNull({
        projectId,
        externalId,
    }: GetOneByExternalIdParams): Promise<Table | null> {
        return tableRepo().findOneBy({ projectId, externalId })
    },

    async getTemplate({
        tableId,
        userMetadata,
        projectId,
        includeRecords = true,
        maxRecords,
    }: GetTemplateParams): Promise<SharedTemplate> {
        const table = await this.getOneOrThrow({
            id: tableId,
            projectId,
        })

        const fields = await fieldService.getAll({ projectId, tableId })

        const populatedTable: PopulatedTable = {
            ...table,
            fields,
        }

        const tableState = {
            id: populatedTable.id,
            name: populatedTable.name,
            externalId: populatedTable.externalId,
            status: populatedTable.status,
            trigger: populatedTable.trigger,
            fields: populatedTable.fields.map((f) => ({
                id: f.id,
                name: f.name,
                type: f.type,
                ...('data' in f ? { data: f.data } : {}),
                externalId: f.externalId,
            })),
        }

        const records = includeRecords
            ? await recordRepo().find({
                where: { tableId: table.id, projectId },
                relations: ['cells'],
                order: { created: 'ASC' },
                ...(maxRecords === undefined ? {} : { take: maxRecords }),
            })
            : []

        const rows: TableDataState['rows'] = records.map((record) => {
            const row: { fieldId: string, value: string }[] = []
            for (const field of fields) {
                const cell = record.cells.find((c) => c.fieldId === field.id)
                row.push({
                    fieldId: field.externalId,
                    value: cell?.value?.toString() ?? '',
                })
            }
            return row
        })

        const tableTemplate: TableTemplate = {
            ...tableState,
            data: includeRecords
                ? {
                    type: TableImportDataType.CSV,
                    rows,
                }
                : null,
        }

        const template: SharedTemplate = {
            name: table.name,
            summary: '',
            description: '',
            qadams: [tablePieceName],
            tables: [tableTemplate],
            tags: [],
            blogUrl: '',
            metadata: {
                externalId: table.externalId,
            },
            author: userMetadata ? `${userMetadata.firstName} ${userMetadata.lastName}` : '',
            categories: [],
            type: TemplateType.SHARED,
            status: TemplateStatus.PUBLISHED,
        }
        return template
    },

    async delete({
        projectId,
        id,
    }: DeleteParams): Promise<void> {

        await tableRepo().delete({
            projectId,
            id,
        })
    },

    async exportTable({
        projectId,
        id,
    }: ExportTableParams): Promise<ExportTableResponse> {
        const table = await this.getOneOrThrow({ projectId, id })

        // TODO: Change field sorting to use position when it's added
        const fields = await fieldService.getAll({ projectId, tableId: id })

        const records = await recordRepo().find({
            where: { tableId: id, projectId },
            relations: ['cells'],
        })

        const rows = records.map((record) => {
            const row: Record<string, string> = {}
            for (const field of fields) {
                const cell = record.cells.find((c) => c.fieldId === field.id)
                row[field.name] = cell?.value?.toString() ?? ''
            }
            return row
        })

        return {
            fields: fields.map((f) => ({ id: f.id, name: f.name })),
            rows,
            name: table.name,
        }
    },

    async createWebhook({
        projectId,
        id,
        request,
    }: CreateWebhookParams): Promise<TableWebhook> {
        return tableWebhookRepo().save({
            id: apId(),
            projectId,
            tableId: id,
            events: request.events,
            flowId: request.flowId,
        })
    },

    async deleteWebhook({
        projectId,
        id,
        webhookId,
    }: DeleteWebhookParams): Promise<void> {
        await tableWebhookRepo().delete({
            projectId,
            tableId: id,
            id: webhookId,
        })
    },

    async getWebhooks({
        projectId,
        id,
        events,
    }: GetWebhooksParams): Promise<TableWebhook[]> {
        return tableWebhookRepo().find({
            where: { projectId, tableId: id, events: ArrayContains(events) },
        })
    },

    async update({
        projectId,
        id,
        request,
        entityManager,
    }: UpdateParams): Promise<Table> {

        const updateData: Record<string, unknown> = {
            ...spreadIfDefined('name', request.name),
            ...spreadIfDefined('trigger', request.trigger),
            ...spreadIfDefined('status', request.status),
            folderId: request.folderId,
        }

        await tableRepo(entityManager).update({ id, projectId }, updateData)
        return this.getOneOrThrow({ projectId, id, entityManager })
    },
    async count({ projectId, folderId }: CountParams): Promise<number> {
        const where: Record<string, unknown> = { projectId }
        if (!isNil(folderId)) {
            where.folderId = folderId === UncategorizedFolderId ? null : folderId
        }
        return tableRepo().count({ where })
    },

    // Declares (non-empty `keyFieldIds`) or clears (empty) a table's business key
    // (#409). Runs inside one transaction: computes `keyValue` for every existing
    // record under the proposed key via the exact same `tableKey` reader record.service.ts
    // uses for every other write, rejects — without listing which records collide, a
    // deliberate scope simplification — if any two would share a value, and otherwise
    // backfills every row and persists `table.keyFieldIds`. Bounded by
    // MAX_RECORDS_PER_TABLE / MAX_FIELDS_PER_TABLE, which already cap how expensive
    // this one-time scan can be.
    async declareKey({ projectId, id, keyFieldIds }: DeclareKeyParams): Promise<Table> {
        const uniqueKeyFieldIds = unique(keyFieldIds)
        if (uniqueKeyFieldIds.length === 0) {
            return this.clearKey({ projectId, id })
        }

        return duplicateKeyError.map(() => transaction(async (entityManager: EntityManager) => {
            // The exclusive half of the lock every record write takes shared. It is what
            // makes the scan below trustworthy: without it a create() that read
            // `keyFieldIds: null` a moment ago can still commit after this transaction
            // does, landing a row with `keyValue` NULL that the backfill never sees and
            // the partial index never covers. It also serialises two concurrent
            // declareKey calls, which would otherwise both pass their own scan.
            await entityManager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tableKey.lockName({ projectId, tableId: id })])
            await this.getOneOrThrow({ projectId, id, entityManager })

            const fields = await fieldService.getAll({ projectId, tableId: id, entityManager })
            const fieldIds = new Set(fields.map((field) => field.id))
            const unknownFieldIds = uniqueKeyFieldIds.filter((fieldId) => !fieldIds.has(fieldId))
            if (unknownFieldIds.length > 0) {
                // Bounded the way record.service.ts bounds the same list, by COUNT and by
                // LENGTH: the ids are caller-supplied and this message rides on
                // Error.message into the server logs, so neither how many arrive nor how
                // long each one is may decide how big that string gets.
                const message = formErrors.tableKeyColumnsNotInTable
                const reported = unknownFieldIds.slice(0, MAX_REPORTED_FIELD_IDS).join(', ').slice(0, MAX_REPORTED_MESSAGE_LENGTH)
                throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Key column(s) not present in table ${id}: ${reported}`)
            }

            const records = await recordRepo(entityManager).find({ where: { projectId, tableId: id }, select: ['id'] })
            const keyCells = records.length === 0 ? [] : await entityManager.getRepository(CellEntity).find({
                where: { projectId, fieldId: In(uniqueKeyFieldIds), recordId: In(records.map((record) => record.id)) },
            })
            const cellsByRecordId = new Map<string, { fieldId: string, value: unknown }[]>()
            for (const cell of keyCells) {
                const group = cellsByRecordId.get(cell.recordId)
                if (group) {
                    group.push(cell)
                }
                else {
                    cellsByRecordId.set(cell.recordId, [cell])
                }
            }

            const keyOf = tableKey.buildValueReader({ keyFieldIds: uniqueKeyFieldIds })
            const seenKeyValues = new Set<string>()
            const recordKeyValues: { id: string, keyValue: string }[] = []
            for (const record of records) {
                const keyValue = keyOf(cellsByRecordId.get(record.id) ?? [])
                // A record whose key columns are all empty has no key, so it stays out of
                // the partial index rather than competing for the all-empty key value —
                // several such rows are not duplicates of each other.
                if (isNil(keyValue)) {
                    continue
                }
                if (seenKeyValues.has(keyValue)) {
                    const message = formErrors.tableHasDuplicateKeys
                    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, 'This table has records that share the same key value(s). Resolve the duplicates before declaring this key.')
                }
                seenKeyValues.add(keyValue)
                recordKeyValues.push({ id: record.id, keyValue })
            }

            // Cleared before anything is written, in one statement. The scan above proves
            // the FINAL set of key values is collision-free, but the index is not
            // deferrable, so a row-at-a-time backfill can still violate it in an
            // INTERMEDIATE state whenever the new values permute values other rows still
            // hold (r1 takes r2's old key before r2 has moved). Emptying the table's slice
            // of the index first makes the order irrelevant, and it is also what clears
            // the stale values a previous clearKey left behind.
            await clearKeyValues({ entityManager, projectId, tableId: id })
            await backfillKeyValues({ entityManager, projectId, tableId: id, rows: recordKeyValues })

            await entityManager.getRepository(TableEntity).update({ id, projectId }, { keyFieldIds: uniqueKeyFieldIds })
            return this.getOneOrThrow({ projectId, id, entityManager })
        }))
    },

    // Clears the declaration AND every `record.keyValue` under it, in one statement each.
    // Leaving the values behind would be wrong, not merely untidy: the index is partial on
    // `WHERE "keyValue" IS NOT NULL` and does NOT consult `table.keyFieldIds`, so a stale
    // value stays a live index entry. Rows edited while the table is unkeyed are not
    // recomputed, so those entries drift away from the cells they claim to describe —
    // and the next declareKey then has to write new values around index entries that no
    // longer correspond to anything. `record.keyValue` is also part of the Record
    // response, where a key that no longer reflects the row's cells is a lie to the API
    // consumer.
    async clearKey({ projectId, id, entityManager }: ClearKeyParams): Promise<Table> {
        const clearWithManager = async (manager: EntityManager): Promise<Table> => {
            // Same exclusive lock declareKey takes, for the mirror-image reason: without it
            // a create() that already read the key can commit after these values are
            // nulled, leaving one stale entry in the index behind a table that no longer
            // has a key.
            await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tableKey.lockName({ projectId, tableId: id })])
            await manager.getRepository(TableEntity).update({ id, projectId }, { keyFieldIds: null })
            await clearKeyValues({ entityManager: manager, projectId, tableId: id })
            return this.getOneOrThrow({ projectId, id, entityManager: manager })
        }
        return isNil(entityManager) ? transaction(clearWithManager) : clearWithManager(entityManager)
    },

}

// One statement, not a row-at-a-time loop: this runs on a table that can hold
// MAX_RECORDS_PER_TABLE rows, and the predicate keeps it to the rows that are actually
// in the partial index.
async function clearKeyValues({ entityManager, projectId, tableId }: KeyValueScopeParams): Promise<void> {
    await entityManager.query('UPDATE "record" SET "keyValue" = NULL WHERE "projectId" = $1 AND "tableId" = $2 AND "keyValue" IS NOT NULL', [projectId, tableId])
}

// Batched through unnest rather than one UPDATE per record. The row-at-a-time version
// held a pool connection for up to MAX_RECORDS_PER_TABLE sequential round-trips inside a
// single transaction, which is how a handful of concurrent declareKey calls starve
// AP_POSTGRES_POOL_SIZE. `projectId`/`tableId` stay in the WHERE clause so the statement
// can never reach another tenant's rows even if an id were wrong.
async function backfillKeyValues({ entityManager, projectId, tableId, rows }: BackfillKeyValuesParams): Promise<void> {
    for (const batch of chunk(rows, KEY_BACKFILL_BATCH_SIZE)) {
        await entityManager.query(`
            UPDATE "record" SET "keyValue" = source."keyValue"
            FROM unnest($1::text[], $2::text[]) AS source(id, "keyValue")
            WHERE "record"."id" = source.id AND "record"."projectId" = $3 AND "record"."tableId" = $4
        `, [batch.map((row) => row.id), batch.map((row) => row.keyValue), projectId, tableId])
    }
}


type CreateParams = {
    projectId: string
    request: CreateTableRequest
}

type ListParams = {
    projectId: string
    cursor: string | undefined
    limit: number
    name: string | undefined
    externalIds: string[] | undefined
    folderId: string | undefined
    folderIds?: string[] | undefined
    includeRowCount?: boolean
}

type GetByIdParams = {
    projectId: string
    id: string
    entityManager?: EntityManager
}

type GetOneByExternalIdParams = {
    projectId: string
    externalId: string
}

type DeleteParams = {
    projectId: string
    id: string
}

type ExportTableParams = {
    projectId: string
    id: string
}

type CreateWebhookParams = {
    projectId: string
    id: string
    request: CreateTableWebhookRequest
}

type DeleteWebhookParams = {
    projectId: string
    id: string
    webhookId: string
}

type GetWebhooksParams = {
    projectId: string
    id: string
    events: TableWebhookEventType[]
}

type UpdateParams = {
    projectId: string
    id: string
    request: UpdateTableRequest
    entityManager?: EntityManager
}

type CountParams = {
    projectId: string
    folderId?: string
}

type GetTemplateParams = {
    tableId: string
    userMetadata: UserWithMetaInformation | null
    projectId: string
    includeRecords?: boolean
    maxRecords?: number
}

type DeclareKeyParams = {
    projectId: string
    id: string
    keyFieldIds: string[]
}

type ClearKeyParams = {
    projectId: string
    id: string
    entityManager?: EntityManager
}

type KeyValueScopeParams = {
    entityManager: EntityManager
    projectId: string
    tableId: string
}

type BackfillKeyValuesParams = KeyValueScopeParams & {
    rows: { id: string, keyValue: string }[]
}

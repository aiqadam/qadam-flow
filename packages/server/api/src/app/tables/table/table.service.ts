import {
    apId,
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
import { buildKeyReader } from '../record/key-reader'
import { RecordEntity } from '../record/record.entity'
import { TableWebhookEntity } from './table-webhook.entity'
import { TableEntity } from './table.entity'

export const tableRepo = repoFactory(TableEntity)
export const recordRepo = repoFactory(RecordEntity)
const tableWebhookRepo = repoFactory(TableWebhookEntity)
const tablePieceName = '@aiqadam/qadam-tables'

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
    // record under the proposed key via the exact same `buildKeyReader` record.service.ts
    // uses for every other write, rejects — without listing which records collide, a
    // deliberate scope simplification — if any two would share a value, and otherwise
    // backfills every row and persists `table.keyFieldIds`. Bounded by
    // MAX_RECORDS_PER_TABLE / MAX_FIELDS_PER_TABLE, which already cap how expensive
    // this one-time scan can be, so no additional pagination/batching.
    async declareKey({ projectId, id, keyFieldIds }: DeclareKeyParams): Promise<Table> {
        const uniqueKeyFieldIds = unique(keyFieldIds)
        if (uniqueKeyFieldIds.length === 0) {
            return this.clearKey({ projectId, id })
        }

        return transaction(async (entityManager: EntityManager) => {
            await this.getOneOrThrow({ projectId, id, entityManager })

            const fields = await fieldService.getAll({ projectId, tableId: id, entityManager })
            const fieldIds = new Set(fields.map((field) => field.id))
            const unknownFieldIds = uniqueKeyFieldIds.filter((fieldId) => !fieldIds.has(fieldId))
            if (unknownFieldIds.length > 0) {
                const message = `Key column(s) not present in table ${id}: ${unknownFieldIds.join(', ')}`
                throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
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

            const keyOf = buildKeyReader({ keyFieldIds: uniqueKeyFieldIds })
            const seenKeyValues = new Set<string>()
            const recordKeyValues: { id: string, keyValue: string }[] = []
            for (const record of records) {
                const keyValue = keyOf(cellsByRecordId.get(record.id) ?? [])
                if (seenKeyValues.has(keyValue)) {
                    const message = formErrors.tableHasDuplicateKeys
                    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, 'This table has records that share the same key value(s). Resolve the duplicates before declaring this key.')
                }
                seenKeyValues.add(keyValue)
                recordKeyValues.push({ id: record.id, keyValue })
            }

            // Sequential, not Promise.all: every query here shares the transaction's one
            // connection, and issuing them concurrently on it is not something a single
            // Postgres connection can do.
            for (const row of recordKeyValues) {
                await entityManager.getRepository(RecordEntity).update({ id: row.id, projectId, tableId: id }, { keyValue: row.keyValue })
            }

            await entityManager.getRepository(TableEntity).update({ id, projectId }, { keyFieldIds: uniqueKeyFieldIds })
            return this.getOneOrThrow({ projectId, id, entityManager })
        })
    },

    // Unconditional: clearing never violates the partial unique index (a null keyValue
    // matches nothing), so no backfill or collision check is needed. `record.keyValue`
    // is deliberately left as-is rather than nulled out — it becomes dead data once the
    // key is cleared, and wiping MAX_RECORDS_PER_TABLE rows of it would cost a full
    // table scan for no behavioural difference (a table with `keyFieldIds: null` is
    // never a target of the index, regardless of what `keyValue` still holds).
    async clearKey({ projectId, id, entityManager }: ClearKeyParams): Promise<Table> {
        await tableRepo(entityManager).update({ id, projectId }, { keyFieldIds: null })
        return this.getOneOrThrow({ projectId, id, entityManager })
    },

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
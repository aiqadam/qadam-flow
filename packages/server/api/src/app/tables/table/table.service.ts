import {
    apId,
    CreateTableRequest,
    CreateTableWebhookRequest,
    ErrorCode,
    ExportTableResponse,
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
    UpdateTableRequest,
    UserWithMetaInformation,
} from '@aiqadam/shared'
import { ArrayContains, EntityManager, ILike, In, IsNull } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { getFolderIdFromRequest } from '../../flows/flow/flow.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { system } from '../../helper/system/system'
import { fieldService } from '../field/field.service'
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
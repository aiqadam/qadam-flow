import {
    apId,
    chunk,
    CreateRecordsRequest,
    Cursor,
    ErrorCode,
    Field,
    Filter,
    isNil,
    PopulatedRecord,
    QadamFlowError,
    SeekPage,
    TableWebhook,
    TableWebhookEventType,
    unique,
    UpdateRecordRequest,
    UpdateRecordsRequest,
    UpsertAction,
    UpsertRecordsRequest,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { WebhookFlowVersionToRun, webhookService } from '../../webhooks/webhook.service'
import { FieldEntity } from '../field/field.entity'
import { fieldService } from '../field/field.service'
import { tableService } from '../table/table.service'
import { CellEntity } from './cell.entity'
import { recordFilter } from './record-filter'
import { RecordEntity, RecordSchema } from './record.entity'

const MAX_BATCH_SIZE = 50

const MAX_REPORTED_FIELD_IDS = 10

const recordRepo = repoFactory(RecordEntity)
const cellsRepo = repoFactory(CellEntity)

export const recordService = {
    async create({
        request,
        projectId,
        fields,
    }: CreateParams): Promise<PopulatedRecord[]> {
        await this.validateCount({ projectId, tableId: request.tableId }, request.records.length)
        const existingFields = fields ?? await fieldService.getAll({
            tableId: request.tableId,
            projectId,
        })

        const validRecords = request.records.map((recordData) =>
            recordData.filter((cellData) =>
                existingFields.some((field) => field.id === cellData.fieldId),
            ),
        )

        let insertedRecordIds: string[] = []
        insertedRecordIds = await transaction(async (entityManager: EntityManager) => {
            const batches = chunk(validRecords, MAX_BATCH_SIZE)
            const records: RecordSchema[] = []
            const insertedRecordIds: string[] = []

            for (const batch of batches) {
                const now = new Date(new Date().getTime() + records.length)
                const recordInsertions = prepareRecordInsertions(batch, request.tableId, projectId, now)
                await entityManager.getRepository(RecordEntity).insert(recordInsertions)

                const cellInsertions = prepareCellInsertions(batch, recordInsertions, projectId)
                await entityManager.getRepository(CellEntity).insert(cellInsertions)

                insertedRecordIds.push(...recordInsertions.map((r) => r.id))
            }

            return insertedRecordIds
        })

        const insertedRecords = await recordRepo().find({
            where: { id: In(insertedRecordIds), tableId: request.tableId, projectId },
            relations: ['cells'],
            order: {
                created: 'ASC',
            },
        })
        return formatRecordsAndFetchField({ records: insertedRecords, tableId: request.tableId, projectId, fields: existingFields })
    },

    async list({
        tableId,
        projectId,
        filters,
        limit,
        fieldIds,
        recordIds,
        fields: prefetchedFields,
    }: ListParams): Promise<SeekPage<PopulatedRecord>> {
        const fields = prefetchedFields ?? await fieldService.getAll({
            tableId,
            projectId,
        })
        const compiledFilters = recordFilter.compile({ filters, fields, tableId })
        const projectedFields = resolveProjectedFields({ fieldIds, fields, tableId })
        // Pushed into SQL, where it is served by idx_record_table_id_project_id_record_id,
        // rather than materialising the whole table and discarding it in JS.
        const records = await recordRepo().find({
            where: {
                projectId,
                tableId,
                ...(isNil(recordIds) ? {} : { id: In(recordIds) }),
            },
            order: {
                created: 'ASC',
            },
        })

        // The union of projected and filtered columns, never just the projection.
        // Filters are evaluated in JS against the cells fetched here, and a filter
        // whose column was not fetched finds no cell — which the missing-cell guard
        // reads as "matches" for NOT_EXISTS, i.e. the whole table. That is the #382
        // fail-open reached through a different door.
        const cellFieldIds = unique([...projectedFields, ...fields.filter((field) => compiledFilters.some((compiled) => compiled.fieldId === field.id))].map((field) => field.id))
        const cells = await cellsRepo().find({
            where: {
                projectId,
                fieldId: In(cellFieldIds),
                recordId: In(records.map((record) => record.id)),
            },
        })
        const cellsByRecordId = new Map<string, typeof cells>()
        for (const cell of cells) {
            const group = cellsByRecordId.get(cell.recordId)
            if (group) {
                group.push(cell)
            }
            else {
                cellsByRecordId.set(cell.recordId, [cell])
            }
        }
        for (const record of records) {
            record.cells = cellsByRecordId.get(record.id) ?? []
        }
        const filteredOutRecords = records.filter((record) => recordFilter.matchesAll({ cells: record.cells, compiledFilters }))

        const populatedRecords = await formatRecordsAndFetchField({ records: filteredOutRecords, tableId, projectId, fields, outputFields: projectedFields })

        return {
            data: populatedRecords.slice(0, limit),
            next: null,
            previous: null,
        }
    },

    async getById({
        id,
        projectId,
        fieldIds,
    }: GetByIdParams): Promise<PopulatedRecord> {
        const record = await recordRepo().findOne({
            where: { id, projectId },
            relations: ['cells'],
        })

        if (isNil(record)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Record',
                    entityId: id,
                },
            })
        }

        if (isNil(fieldIds)) {
            const result = await formatRecordsAndFetchField({ records: [record], tableId: record.tableId, projectId: record.projectId })
            return result[0]
        }

        // Validated against the record's own table, not one the caller named:
        // getById is addressed by record id alone, so a caller-supplied table id
        // would be an unchecked assertion about where the record lives.
        const fields = await fieldService.getAll({ tableId: record.tableId, projectId: record.projectId })
        const projectedFields = resolveProjectedFields({ fieldIds, fields, tableId: record.tableId })
        const result = await formatRecordsAndFetchField({ records: [record], tableId: record.tableId, projectId: record.projectId, fields, outputFields: projectedFields })
        return result[0]
    },

    // Match on a business key, then insert or update — the primitive that makes
    // "exactly once" expressible at all. Without it every such requirement is
    // read -> branch -> write with a window in between, and two deliveries inside
    // that window both see "not seen yet".
    async upsert({ request, projectId }: UpsertParams): Promise<UpsertResult[]> {
        const { tableId, keyFieldIds, records } = request

        return transaction(async (entityManager: EntityManager) => {
            // A Postgres transaction-scoped lock, not the Redis distributedLock.
            // ai-provider-service.ts's custom-provider cap records the first reason:
            // it cannot expire before the insert it guards commits. The second is
            // this file's own: under REDIS_TYPE=MEMORY every API process gets its own
            // in-process Redis, so that lock is per-process and not distributed at all.
            // Keyed per table rather than per key tuple: one acquisition instead of
            // N, and no lock-ordering deadlock between two batches that overlap.
            await entityManager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tables-upsert:${projectId}:${tableId}`])

            const existingFields = await entityManager.getRepository(FieldEntity).find({ where: { projectId, tableId } })
            const fieldIds = new Set(existingFields.map((field) => field.id))
            assertKeyFieldsBelongToTable({ keyFieldIds, fieldIds, tableId })

            const keyOf = buildKeyReader({ keyFieldIds })
            const existingByKey = await indexExistingRecordsByKey({ entityManager, projectId, tableId, keyFieldIds, keyOf })

            const validRecords = records.map((cells) => cells.filter((cellData) => fieldIds.has(cellData.fieldId)))
            assertEveryRecordCarriesTheKey({ records: validRecords, keyFieldIds })
            assertNoRepeatedKey({ records: validRecords, keyOf })

            const outcomes: { action: UpsertAction, recordId: string }[] = []
            const toInsert: { cells: { fieldId: string, value: string | null }[], index: number }[] = []

            for (const [index, cells] of validRecords.entries()) {
                const matches = existingByKey.get(keyOf(cells)) ?? []
                if (matches.length > 1) {
                    const message = `Key ${keyOf(cells)} matches ${matches.length} records in table ${tableId}. Resolve the duplicates before upserting on this key.`
                    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
                }
                if (matches.length === 0) {
                    toInsert.push({ cells, index })
                    outcomes.push({ action: UpsertAction.CREATED, recordId: '' })
                    continue
                }
                outcomes.push({ action: UpsertAction.UPDATED, recordId: matches[0] })
            }

            // Counted inside the lock, with only the rows actually being inserted —
            // unlike create(), which charges the whole request against the cap.
            if (toInsert.length > 0) {
                await this.validateCount({ projectId, tableId }, toInsert.length)
                const insertions = prepareRecordInsertions(toInsert.map((row) => row.cells), tableId, projectId, new Date())
                const cellInsertions = prepareCellInsertions(toInsert.map((row) => row.cells), insertions, projectId)
                // Chunked, as create() is. One statement carrying every row of a
                // 1000-record batch exceeds the wire protocol's parameter limit and
                // the whole transaction dies with a Postgres 08P01 — on a batch size
                // the request schema explicitly permits.
                for (const batch of chunk(insertions, MAX_BATCH_SIZE)) {
                    await entityManager.getRepository(RecordEntity).insert(batch)
                }
                for (const batch of chunk(cellInsertions, MAX_BATCH_SIZE)) {
                    await entityManager.getRepository(CellEntity).insert(batch)
                }
                toInsert.forEach((row, position) => {
                    outcomes[row.index].recordId = insertions[position].id
                })
            }

            const cellsToUpsert = validRecords.flatMap((cells, index) =>
                outcomes[index].action === UpsertAction.CREATED ? [] : cells.map((cellData) => ({
                    recordId: outcomes[index].recordId,
                    fieldId: cellData.fieldId,
                    projectId,
                    value: cellData.value ?? '',
                    id: apId(),
                })),
            )
            for (const batch of chunk(cellsToUpsert, MAX_BATCH_SIZE)) {
                await entityManager.getRepository(CellEntity).upsert(batch, ['projectId', 'fieldId', 'recordId'])
            }

            const stored = await entityManager.getRepository(RecordEntity).find({
                where: { id: In(outcomes.map((outcome) => outcome.recordId)), projectId, tableId },
                relations: ['cells'],
            })
            const populated = formatRecords({ records: stored, fields: existingFields })
            const populatedById = new Map(populated.map((record) => [record.id, record]))

            // In input order, so the caller can line results up with what it sent.
            return outcomes.map((outcome) => ({
                action: outcome.action,
                record: populatedById.get(outcome.recordId),
            })).filter((result): result is UpsertResult => !isNil(result.record))
        })
    },

    // One transaction, one field lookup and one cell upsert per chunk for the whole
    // batch, against one transaction + two field queries PER RECORD through the
    // single-record path. Deliberately does NOT call validateCount: an update
    // creates no rows, and counting would reject legitimate updates on any table
    // already at MAX_RECORDS_PER_TABLE.
    async updateMany({
        request,
        projectId,
    }: UpdateManyParams): Promise<PopulatedRecord[]> {
        const { tableId, records } = request
        assertNoRepeatedTarget({ records })

        let batchFields: Field[] = []
        const updatedRecordIds = await transaction(async (entityManager: EntityManager) => {
            const existingFields = await entityManager.getRepository(FieldEntity).find({
                where: { projectId, tableId },
            })
            batchFields = existingFields
            const fieldIds = new Set(existingFields.map((field) => field.id))

            const existingIds = new Set((await entityManager.getRepository(RecordEntity).find({
                where: { id: In(records.map((record) => record.id)), projectId, tableId },
                select: ['id'],
            })).map((record) => record.id))

            // Every id is checked, not just the first, and a miss rolls the whole
            // batch back rather than half-applying it.
            const missingId = records.find((record) => !existingIds.has(record.id))?.id
            if (!isNil(missingId)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: { entityType: 'Record', entityId: missingId },
                })
            }

            const cellsToUpsert = records.flatMap((record) =>
                record.cells
                    .filter((cellData) => fieldIds.has(cellData.fieldId))
                    .map((cellData) => ({
                        recordId: record.id,
                        fieldId: cellData.fieldId,
                        projectId,
                        value: cellData.value ?? '',
                        id: apId(),
                    })),
            )

            // Sorted so every batch takes cell row locks in the same order. Two
            // concurrent batches touching {A,B} and {B,A} would otherwise deadlock,
            // and the single-record path's one-record-wide window becomes N wide
            // the moment updates are batched.
            const ordered = [...cellsToUpsert].sort((left, right) => `${left.recordId}:${left.fieldId}`.localeCompare(`${right.recordId}:${right.fieldId}`))
            for (const batch of chunk(ordered, MAX_BATCH_SIZE)) {
                await entityManager.getRepository(CellEntity).upsert(batch, ['projectId', 'fieldId', 'recordId'])
            }

            return records.map((record) => record.id)
        })

        const updatedRecords = await recordRepo().find({
            where: { id: In(updatedRecordIds), projectId, tableId },
            relations: ['cells'],
        })
        // Re-ordered into request order rather than left in whatever order the
        // re-read returned: create-records comes back in input order, so a flow
        // author indexing step.output[i] against their own array would be right
        // there and silently wrong here.
        const byId = new Map(updatedRecords.map((record) => [record.id, record]))
        const inRequestOrder = updatedRecordIds.flatMap((recordId) => {
            const record = byId.get(recordId)
            return isNil(record) ? [] : [record]
        })
        return formatRecordsAndFetchField({ records: inRequestOrder, tableId, projectId, fields: batchFields })
    },

    async update({
        id,
        projectId,
        request,
    }: UpdateParams): Promise<PopulatedRecord> {
        const { tableId } = request
        return transaction(async (entityManager: EntityManager) => {
            const record = await entityManager.getRepository(RecordEntity).findOne({
                where: { projectId, tableId, id },
                // Taken unconditionally, not only when a precondition is present:
                // otherwise a plain concurrent update can still clobber between a
                // conditional update's check and its write, which is the race the
                // precondition exists to close.
                lock: { mode: 'pessimistic_write' },
            })

            if (isNil(record)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'Record',
                        entityId: id,
                    },
                })
            }

            await assertPreconditionHolds({ entityManager, record, request, projectId, tableId })

            if (request.cells && request.cells.length > 0) {
                const existingFields = await entityManager
                    .getRepository(FieldEntity)
                    .find({
                        where: { projectId, tableId },
                    })

                // Filter out cells with non-existing fields
                const validCells = request.cells.filter((cellData) =>
                    existingFields.some((field) => field.id === cellData.fieldId),
                )

                // Prepare cells for upsert
                const cellsToUpsert = validCells.map((cellData) => {
                    return {
                        recordId: id,
                        fieldId: cellData.fieldId,
                        projectId,
                        value: cellData.value ?? '',
                        id: apId(),
                    }
                })

                // Perform bulk upsert only for valid cells
                if (cellsToUpsert.length > 0) {
                    await entityManager
                        .getRepository(CellEntity)
                        .upsert(cellsToUpsert, ['projectId', 'fieldId', 'recordId'])
                }
            }

            // Fetch and return the updated record with full details
            const updatedRecord = await entityManager
                .getRepository(RecordEntity)
                .findOne({
                    where: { id, projectId, tableId },
                    relations: ['cells'],
                })

            if (isNil(updatedRecord)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'Record',
                        entityId: id,
                    },
                })
            }

            const result = await formatRecordsAndFetchField({ records: [updatedRecord], tableId: updatedRecord.tableId, projectId: updatedRecord.projectId })
            return result[0]
        })
    },

    async delete({
        ids,
        projectId,
    }: DeleteParams): Promise<PopulatedRecord[]> {
        const firstRecord = await recordRepo().findOne({
            where: { id: ids[0], projectId },
            select: ['tableId'],
        })
        if (isNil(firstRecord)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityType: 'Record', entityId: ids[0] },
            })
        }

        const records = await recordRepo().find({
            where: { id: In(ids), projectId, tableId: firstRecord.tableId },
            relations: ['cells'],
        })

        await recordRepo().delete({
            id: In(ids),
            projectId,
            tableId: firstRecord.tableId,
        })

        if (records.length === 0) {
            return []
        }

        return formatRecordsAndFetchField({ records, tableId: firstRecord.tableId, projectId })
    },

    async deleteAll({
        tableId,
        projectId,
    }: DeleteAllParams): Promise<PopulatedRecord[]> {
        const deletedRecords = await transaction(async (entityManager: EntityManager) => {
            const records = await entityManager.getRepository(RecordEntity).find({
                where: { projectId, tableId },
                relations: ['cells'],
            })

            const recordIds = records.map((record) => record.id)

            if (recordIds.length > 0) {
                await entityManager.getRepository(RecordEntity).delete({
                    id: In(recordIds),
                    projectId,
                    tableId,
                })
            }

            return records
        })

        if (deletedRecords.length === 0) {
            return []
        }

        return formatRecordsAndFetchField({ records: deletedRecords, tableId, projectId })
    },

    async triggerWebhooks({
        projectId,
        tableId,
        eventType,
        data,
        logger,
        authorization,
        webhooks: prefetchedWebhooks,
    }: TriggerWebhooksParams): Promise<void> {
        // Accepted from the caller so a batch can look them up once; still fetched
        // here when a single-record caller does not supply them.
        const webhooks = prefetchedWebhooks ?? await tableService.getWebhooks({
            projectId,
            id: tableId,
            events: [eventType],
        })

        if (webhooks.length === 0) {
            return
        }
        await Promise.all(webhooks.map((webhook) => {
            return webhookService.handleWebhook({
                async: true,
                flowId: webhook.flowId,
                flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
                saveSampleData: false,
                data: async (_projectId: string) => ({
                    method: 'POST',
                    headers: {
                        authorization,
                    },
                    body: data,
                    queryParams: {},
                }),
                execute: true,
                logger,
                failParentOnFailure: true,
            })
        }))
    },

    async count({ projectId, tableId }: CountParams): Promise<number> {
        return recordRepo().count({
            where: { projectId, tableId },
        })
    },
    async validateCount(params: CountParams, insertCount: number): Promise<void> {
        const countRes = await this.count(params)
        if (countRes + insertCount > system.getNumberOrThrow(AppSystemProp.MAX_RECORDS_PER_TABLE)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Max records per table reached: ${system.getNumberOrThrow(AppSystemProp.MAX_RECORDS_PER_TABLE)}`,
                },
            })
        }
    },
}

type CreateParams = {
    request: CreateRecordsRequest
    projectId: string
    logger: FastifyBaseLogger
    fields?: Field[]
}

type ListParams = {
    tableId: string
    projectId: string
    cursorRequest: Cursor | null
    limit: number
    filters: Filter[] | null
    fieldIds?: string[]
    recordIds?: string[]
    fields?: Field[]
}

type GetByIdParams = {
    id: string
    projectId: string
    fieldIds?: string[]
}

type UpdateParams = {
    id: string
    projectId: string
    request: UpdateRecordRequest
}

type UpdateManyParams = {
    request: UpdateRecordsRequest
    projectId: string
}

type UpsertParams = {
    request: UpsertRecordsRequest
    projectId: string
}

type KeyReader = (cells: { fieldId: string, value: unknown }[]) => string

export type UpsertResult = {
    action: UpsertAction
    record: PopulatedRecord
}

type DeleteParams = {
    ids: string[]
    projectId: string
}

type DeleteAllParams = {
    tableId: string
    projectId: string
}

type TriggerWebhooksParams = {
    projectId: string
    tableId: string
    eventType: TableWebhookEventType
    data: Record<string, unknown>
    logger: FastifyBaseLogger
    authorization: string
    webhooks?: TableWebhook[]
}
type CountParams = {
    projectId: string
    tableId: string
}

type RecordInsertion = {
    id: string
    tableId: string
    projectId: string
    created: string
}

type CellInsertion = {
    id: string
    recordId: string
    fieldId: string
    projectId: string
    value: string
}

function prepareRecordInsertions(
    records: Array<Array<{ fieldId: string, value: string | null }>>,
    tableId: string,
    projectId: string,
    baseDate: Date,
): RecordInsertion[] {
    return records.map((_, index) => {
        const created = new Date(baseDate.getTime() + index).toISOString()
        return {
            tableId,
            projectId,
            created,
            id: apId(),
        }
    })
}

function prepareCellInsertions(
    records: Array<Array<{ fieldId: string, value: string | null }>>,
    recordInsertions: RecordInsertion[],
    projectId: string,
): CellInsertion[] {
    return records.flatMap((recordData, index) =>
        recordData.map((cellData) => {
            return {
                recordId: recordInsertions[index].id,
                fieldId: cellData.fieldId,
                projectId,
                value: cellData.value ?? '',
                id: apId(),
            }
        }),
    )
}

// Evaluated inside the caller's transaction, under the row lock taken above, so the
// check and the write commit together. A failed precondition raises rather than
// quietly writing nothing: "it did not apply" has to be distinguishable from "it
// applied", which is the whole contract of compare-and-set.
async function assertPreconditionHolds({ entityManager, record, request, projectId, tableId }: { entityManager: EntityManager, record: RecordSchema, request: UpdateRecordRequest, projectId: string, tableId: string }): Promise<void> {
    const { precondition } = request
    if (isNil(precondition) || precondition.length === 0) {
        return
    }
    const fields = await entityManager.getRepository(FieldEntity).find({ where: { projectId, tableId } })
    const compiledFilters = recordFilter.compile({ filters: precondition, fields, tableId })
    const cells = await entityManager.getRepository(CellEntity).find({
        where: { projectId, recordId: record.id, fieldId: In(compiledFilters.map((compiled) => compiled.fieldId)) },
    })
    if (recordFilter.matchesAll({ cells, compiledFilters })) {
        return
    }
    throw new QadamFlowError({
        code: ErrorCode.RECORD_PRECONDITION_FAILED,
        params: { recordId: record.id },
    })
}

function assertKeyFieldsBelongToTable({ keyFieldIds, fieldIds, tableId }: { keyFieldIds: string[], fieldIds: Set<string>, tableId: string }): void {
    const unknown = unique(keyFieldIds.filter((fieldId) => !fieldIds.has(fieldId)))
    if (unknown.length === 0) {
        return
    }
    const message = `Key column(s) not present in table ${tableId}: ${unknown.slice(0, MAX_REPORTED_FIELD_IDS).join(', ')}`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// A row that does not carry every key column has no key, so it cannot be matched.
// Inserting it anyway would create exactly the duplicate an upsert exists to avoid.
function assertEveryRecordCarriesTheKey({ records, keyFieldIds }: { records: { fieldId: string }[][], keyFieldIds: string[] }): void {
    const index = records.findIndex((cells) => !keyFieldIds.every((fieldId) => cells.some((cellData) => cellData.fieldId === fieldId)))
    if (index === -1) {
        return
    }
    const message = `Record #${index + 1} does not set every key column, so it cannot be matched.`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// Two input rows sharing a key would race each other inside one request: the second
// would match what the first just inserted, or not, depending on statement order.
function assertNoRepeatedKey({ records, keyOf }: { records: { fieldId: string, value: unknown }[][], keyOf: KeyReader }): void {
    const repeated = firstRepeated(records.map(keyOf))
    if (isNil(repeated)) {
        return
    }
    const message = `Key ${repeated} appears more than once in the batch. Merge those rows into one.`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// An absent cell and an empty cell are the same "empty", and both shapes really
// exist: the qadam actions strip empty values before posting, so a record with no
// value has no cell row at all, while the web grid (ap-tables-server-state.ts sends
// String(value)) and any raw API or MCP caller store a literal ''. Matching has to
// treat the two as equal, or an upsert inserts the duplicate it exists to prevent.
function buildKeyReader({ keyFieldIds }: { keyFieldIds: string[] }): KeyReader {
    return (cells) => JSON.stringify(keyFieldIds.map((fieldId) => {
        const value = cells.find((cellData) => cellData.fieldId === fieldId)?.value
        return isNil(value) ? '' : String(value)
    }))
}

// One query for the key columns of the whole table, then matched in memory — rather
// than a correlated subquery per input row, which is N round-trips for a batch.
async function indexExistingRecordsByKey({ entityManager, projectId, tableId, keyFieldIds, keyOf }: { entityManager: EntityManager, projectId: string, tableId: string, keyFieldIds: string[], keyOf: KeyReader }): Promise<Map<string, string[]>> {
    const rows = await entityManager.getRepository(RecordEntity).find({ where: { projectId, tableId }, select: ['id'] })
    if (rows.length === 0) {
        return new Map()
    }
    const cells = await entityManager.getRepository(CellEntity).find({
        where: { projectId, fieldId: In(keyFieldIds), recordId: In(rows.map((row) => row.id)) },
    })
    const cellsByRecordId = new Map<string, { fieldId: string, value: unknown }[]>()
    for (const cell of cells) {
        const group = cellsByRecordId.get(cell.recordId)
        if (group) {
            group.push(cell)
        }
        else {
            cellsByRecordId.set(cell.recordId, [cell])
        }
    }
    const byKey = new Map<string, string[]>()
    for (const row of rows) {
        const key = keyOf(cellsByRecordId.get(row.id) ?? [])
        const matches = byKey.get(key)
        if (matches) {
            matches.push(row.id)
        }
        else {
            byKey.set(key, [row.id])
        }
    }
    return byKey
}

// Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second time"
// — a 500, not a 400 — when one statement carries two rows with the same conflict
// target. A repeated record id, or the same column twice inside one record, is
// exactly that, so both are rejected before the upsert rather than after.
function assertNoRepeatedTarget({ records }: { records: UpdateRecordsRequest['records'] }): void {
    const repeatedRecordId = firstRepeated(records.map((record) => record.id))
    if (!isNil(repeatedRecordId)) {
        const message = `Record ${repeatedRecordId} appears more than once in the batch. Merge its cells into a single entry.`
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
    }
    for (const record of records) {
        const repeatedFieldId = firstRepeated(record.cells.map((cellData) => cellData.fieldId))
        if (!isNil(repeatedFieldId)) {
            const message = `Record ${record.id} sets column ${repeatedFieldId} more than once.`
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
        }
    }
}

function firstRepeated(values: string[]): string | undefined {
    const seen = new Set<string>()
    return values.find((value) => {
        if (seen.has(value)) {
            return true
        }
        seen.add(value)
        return false
    })
}

// An unknown column in a projection is an error, never a silent drop: dropping it
// would quietly widen the read back towards "every column", which is the whole
// thing the projection exists to prevent.
function resolveProjectedFields({ fieldIds, fields, tableId }: { fieldIds: string[] | undefined, fields: Field[], tableId: string }): Field[] {
    if (isNil(fieldIds)) {
        return fields
    }
    const requested = new Set(fieldIds)
    const unknownFieldIds = unique(fieldIds.filter((fieldId) => !fields.some((field) => field.id === fieldId)))
    if (unknownFieldIds.length > 0) {
        // Bounded for the same reason its sibling in record-filter.ts is: the
        // whole list is caller-supplied and this message rides on Error.message
        // into server logs and persisted run output.
        const shown = unknownFieldIds.slice(0, MAX_REPORTED_FIELD_IDS)
        const suffix = unknownFieldIds.length > shown.length ? ` (and ${unknownFieldIds.length - shown.length} more)` : ''
        const message = `Projection references field(s) not present in table ${tableId}: ${shown.join(', ')}${suffix}`
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
    }
    return fields.filter((field) => requested.has(field.id))
}

async function formatRecordsAndFetchField({ records, tableId, projectId, fields: prefetchedFields, outputFields }: { records: RecordSchema[], tableId: string, projectId: string, fields?: Field[], outputFields?: Field[] }): Promise<PopulatedRecord[]> {
    const fields = prefetchedFields ?? await fieldService.getAll({
        tableId,
        projectId,
    })
    return formatRecords({ records, fields: outputFields ?? fields })
}

// `fields` here is the set to EMIT, not the table's schema. A record may carry
// cells for columns that were fetched only to evaluate a filter, and those must
// not reach the output — the filter is often where the sensitive column is.
function formatRecords({ records, fields }: { records: RecordSchema[], fields: Field[] }): PopulatedRecord[] {
    const fieldsNamesMap: Record<string, string> = fields.reduce((acc, field) => {
        acc[field.id] = field.name
        return acc
    }, {} as Record<string, string>)
    return records.map((record) => {
        const cells = record.cells.reduce<PopulatedRecord['cells']>((acc, cell) => {
            if (!(cell.fieldId in fieldsNamesMap)) {
                return acc
            }
            acc[cell.fieldId] = {
                fieldName: fieldsNamesMap[cell.fieldId],
                value: cell.value,
                updated: cell.updated,
                created: cell.created,
            }
            return acc
        }, {})
        // Back-filled from the emitted set too: iterating the whole schema here
        // would publish the names of the very columns the projection withheld.
        for (const field of fields) {
            if (!(field.id in cells)) {
                cells[field.id] = {
                    fieldName: field.name,
                    value: null,
                    updated: record.updated,
                    created: record.created,
                }
            }
        }
        return {
            ...record,
            cells,
        }
    })
}

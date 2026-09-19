import {
    apId,
    chunk,
    CreateRecordsRequest,
    Cursor,
    ErrorCode,
    Field,
    Filter,
    formErrors,
    isNil,
    PopulatedRecord,
    QadamFlowError,
    SeekPage,
    TableWebhook,
    TableWebhookEventType,
    tryCatch,
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
import { assertValidCellValues } from './cell-validation'
import { CellEntity } from './cell.entity'
import { buildKeyReader, KeyReader } from './key-reader'
import { recordFilter } from './record-filter'
import { recordQuery } from './record-query'
import { RecordEntity, RecordSchema } from './record.entity'

const MAX_BATCH_SIZE = 50

const MAX_REPORTED_FIELD_IDS = 10

const MAX_REPORTED_KEY_LENGTH = 120

// The unique index name from migration AddTableKeyDeclaration1789832775045 — matched
// against a Postgres 23505 error's `constraint` to translate it into a
// RECORD_DUPLICATE_KEY QadamFlowError rather than a raw 500. Record has no other
// unique index, so any 23505 raised by a write to this table is this one.
const KEY_VALUE_UNIQUE_INDEX_NAME = 'idx_record_project_id_table_id_key_value_unique'

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
        const fieldsById = new Map(existingFields.map((field) => [field.id, field]))

        const validRecords = request.records.map((recordData) =>
            recordData.filter((cellData) =>
                existingFields.some((field) => field.id === cellData.fieldId),
            ),
        )
        validRecords.forEach((cells) => assertValidCellValues({ cells, fieldsById }))

        // Read once, outside the transaction — declaring or clearing a table's key
        // (#409) is a rare admin operation, and every write path here already reads
        // its schema (existingFields) the same way. A key declared concurrently with
        // this call simply does not cover these rows; tableService.declareKey's own
        // backfill is what closes that gap for existing rows, not this read.
        const table = await tableService.getOneOrThrow({ projectId, id: request.tableId })
        const keyReader = isNil(table.keyFieldIds) || table.keyFieldIds.length === 0 ? null : buildKeyReader({ keyFieldIds: table.keyFieldIds })

        let insertedRecordIds: string[] = []
        insertedRecordIds = await withDuplicateKeyMapping(async () => transaction(async (entityManager: EntityManager) => {
            const batches = chunk(validRecords, MAX_BATCH_SIZE)
            const records: RecordSchema[] = []
            const insertedRecordIds: string[] = []

            for (const batch of batches) {
                const now = new Date(new Date().getTime() + records.length)
                const recordInsertions = prepareRecordInsertions(batch, request.tableId, projectId, now, keyReader)
                await entityManager.getRepository(RecordEntity).insert(recordInsertions)

                const cellInsertions = prepareCellInsertions(batch, recordInsertions, projectId)
                await entityManager.getRepository(CellEntity).insert(cellInsertions)

                insertedRecordIds.push(...recordInsertions.map((r) => r.id))
            }

            return insertedRecordIds
        }))

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
        // Record ids, the filters the database can reproduce, and the limit once nothing is left
        // for the JS pass below to remove — see record-query.ts — rather than materialising the
        // whole table and discarding it in JS.
        const records = await recordQuery.build({ projectId, tableId, recordIds, compiledFilters, limit }).getMany()

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
        const { tableId, records } = request
        // Deduped before anything iterates it. The schema bounds this array's length
        // but not how many DISTINCT ids it holds, and the membership check below tests
        // membership only — so one valid id repeated N times passes every validation
        // and then costs N per record: buildKeyReader walks the whole array once for
        // each existing row in the table. Repeating a key column is semantically a
        // no-op (the same value joins the key twice), so collapsing it changes no
        // result, and after the membership check it bounds the work at the number of
        // columns the table actually has. Without it a single request blocks the API's
        // one event-loop thread for seconds.
        const keyFieldIds = unique(request.keyFieldIds)

        // #409's behaviour split. A table WITH a declared key gets a real
        // INSERT ... ON CONFLICT DO UPDATE keyed on the partial unique index and skips
        // the advisory lock entirely — real per-row concurrency, arbitrated by
        // Postgres rather than this process. A table WITHOUT one keeps today's
        // behaviour verbatim, below, unmodified.
        const table = await tableService.getOneOrThrow({ projectId, id: tableId })
        if (!isNil(table.keyFieldIds) && table.keyFieldIds.length > 0) {
            const declaredKeyFieldIds = table.keyFieldIds
            assertRequestKeyMatchesDeclaredKey({ requestKeyFieldIds: keyFieldIds, declaredKeyFieldIds })
            return withDuplicateKeyMapping(() => transaction((entityManager: EntityManager) =>
                upsertWithDeclaredKey({ entityManager, projectId, tableId, keyFieldIds: declaredKeyFieldIds, records })))
        }

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
            assertNoRepeatedColumn({ records: validRecords })
            assertNoRepeatedKey({ records: validRecords, keyOf })
            const fieldsById = new Map(existingFields.map((field) => [field.id, field]))
            validRecords.forEach((cells) => assertValidCellValues({ cells, fieldsById }))

            const outcomes: { action: UpsertAction, recordId: string }[] = []
            const toInsert: { cells: { fieldId: string, value: string | null }[], index: number }[] = []

            for (const [index, cells] of validRecords.entries()) {
                const matches = existingByKey.get(keyOf(cells)) ?? []
                if (matches.length > 1) {
                    const message = `Key ${truncateKeyForMessage(keyOf(cells))} matches ${matches.length} records in table ${tableId}. Resolve the duplicates before upserting on this key.`
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
                await this.validateCount({ projectId, tableId, entityManager }, toInsert.length)
                const insertions = prepareRecordInsertions(toInsert.map((row) => row.cells), tableId, projectId, new Date(), null)
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

            // The matched rows are locked before their cells are written. The advisory
            // lock above excludes only other upserts; update() and updateMany() take
            // neither it nor — without this — any lock that conflicts with one, so a
            // conditional update's check and its write stay interleavable by this
            // batch. Ordered by Postgres rather than in JS, in the same mode and the
            // same direction those two paths use: a JS sort orders by ICU rules while
            // an ORDER BY uses the database collation, and two orders is exactly how a
            // lock cycle gets back in.
            const matchedIds = outcomes.filter((outcome) => outcome.action === UpsertAction.UPDATED).map((outcome) => outcome.recordId)
            if (matchedIds.length > 0) {
                await entityManager.getRepository(RecordEntity).find({
                    where: { id: In(matchedIds), projectId, tableId },
                    select: ['id'],
                    order: { id: 'ASC' },
                    lock: { mode: 'for_no_key_update' },
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
        const updatedRecordIds = await withDuplicateKeyMapping(() => transaction(async (entityManager: EntityManager) => {
            const existingFields = await entityManager.getRepository(FieldEntity).find({
                where: { projectId, tableId },
            })
            batchFields = existingFields
            const fieldIds = new Set(existingFields.map((field) => field.id))
            const fieldsById = new Map(existingFields.map((field) => [field.id, field]))

            // Locked, not merely read. Writing a cell without holding its record row
            // leaves update()'s precondition check and its write interleavable by this
            // batch, which turns a compare-and-set into a silent lost update: the CAS
            // returns 200 "I claimed it" and this batch overwrites the value it
            // claimed.
            await lockExistingRecordIds({ entityManager, ids: records.map((record) => record.id), projectId, tableId })

            const validCellsByRecordId = new Map(records.map((record) => [record.id, record.cells.filter((cellData) => fieldIds.has(cellData.fieldId))]))
            for (const cells of validCellsByRecordId.values()) {
                assertValidCellValues({ cells, fieldsById })
            }

            const cellsToUpsert = [...validCellsByRecordId.entries()].flatMap(([recordId, cells]) =>
                cells.map((cellData) => ({
                    recordId,
                    fieldId: cellData.fieldId,
                    projectId,
                    value: cellData.value ?? '',
                    id: apId(),
                })),
            )

            // Sorted so every batch takes cell row locks in the same order. This is no
            // longer what keeps two overlapping batches from deadlocking — the record
            // lock taken above does that, and two batches sharing no record share no
            // cell either, since a cell is keyed by its record. Kept because a stable
            // write order is worth having on its own, not because anything depends on
            // it: do NOT read this as the ordering that makes the batch path safe.
            const ordered = [...cellsToUpsert].sort((left, right) => `${left.recordId}:${left.fieldId}`.localeCompare(`${right.recordId}:${right.fieldId}`))
            for (const batch of chunk(ordered, MAX_BATCH_SIZE)) {
                await entityManager.getRepository(CellEntity).upsert(batch, ['projectId', 'fieldId', 'recordId'])
            }

            // #409: same "only if a key field was touched" rule as update(), one record
            // at a time — the batch is capped at MAX_RECORDS_PER_BATCH (1000), and a
            // per-record UPDATE keeps this correct without a bespoke bulk-update
            // statement built on a VALUES join. Simple over fast: this is a place a
            // future optimisation can land without changing behaviour.
            const table = await tableService.getOneOrThrow({ projectId, id: tableId, entityManager })
            if (!isNil(table.keyFieldIds) && table.keyFieldIds.length > 0) {
                const keyFieldIds = table.keyFieldIds
                for (const [recordId, cells] of validCellsByRecordId.entries()) {
                    await recomputeKeyValueIfTouched({ entityManager, projectId, tableId, recordId, keyFieldIds, writtenCells: cells })
                }
            }

            return records.map((record) => record.id)
        }))

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
                //
                // FOR NO KEY UPDATE, not FOR UPDATE. Inserting a cell makes Postgres
                // take FOR KEY SHARE on that cell's record row to validate
                // fk_cell_record_id, and FOR UPDATE conflicts with FOR KEY SHARE — so
                // a cell-writing batch and this lock acquire {record row, cell tuple}
                // in opposite orders and cycle into a 40P01. FOR NO KEY UPDATE does
                // not conflict with FOR KEY SHARE, and does conflict with itself,
                // which is the entire requirement: writers exclude each other without
                // blocking the FK check every one of them depends on.
                lock: { mode: 'for_no_key_update' },
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

            // Read on the transaction's own manager, and hoisted out of the branch
            // below so the response can be formatted from it. Formatting used to call
            // fieldService.getAll on the DEFAULT manager from in here, which takes a
            // SECOND pool connection while this transaction still holds the first: once
            // AP_POSTGRES_POOL_SIZE requests are in this state there is no connection
            // left to hand out, and every one of them waits forever. That is not a lock
            // cycle, so Postgres never breaks it — the process wedges until restarted.
            const existingFields = await entityManager
                .getRepository(FieldEntity)
                .find({
                    where: { projectId, tableId },
                    // Matches fieldService.getAll, which this read replaced. Without it
                    // the response's cells come back in heap order here and in column
                    // order from create, for the same table.
                    order: { created: 'ASC' },
                })
            const fieldsById = new Map(existingFields.map((field) => [field.id, field]))

            if (request.cells && request.cells.length > 0) {
                // Filter out cells with non-existing fields
                const validCells = request.cells.filter((cellData) =>
                    existingFields.some((field) => field.id === cellData.fieldId),
                )
                assertValidCellValues({ cells: validCells, fieldsById })

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

                // #409: recompute keyValue only when this write touches a declared key
                // field, and only for a table that declared one — tables.entity's
                // default of `null` means every other write here is a no-op change,
                // matching "unmodified" behaviour exactly.
                const table = await tableService.getOneOrThrow({ projectId, id: tableId, entityManager })
                if (!isNil(table.keyFieldIds) && table.keyFieldIds.length > 0) {
                    await withDuplicateKeyMapping(() => recomputeKeyValueIfTouched({ entityManager, projectId, tableId, recordId: id, keyFieldIds: table.keyFieldIds as string[], writtenCells: validCells }))
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

            const result = await formatRecordsAndFetchField({ records: [updatedRecord], tableId: updatedRecord.tableId, projectId: updatedRecord.projectId, fields: existingFields })
            return result[0]
        })
    },

    // The table is taken from the caller and used in every where, never derived
    // from the records. Deriving it from ids[0] — which is what this used to do —
    // deleted from whatever table the first record happened to belong to while
    // the caller, and the authorization layer that resolved the body's tableId,
    // had named a different one (#406).
    async delete({
        tableId,
        ids,
        projectId,
    }: DeleteParams): Promise<PopulatedRecord[]> {
        let batchFields: Field[] = []
        const deletedRecords = await transaction(async (entityManager: EntityManager) => {
            // Through the service, not a hand-rolled query: the created-ASC ordering
            // the response depends on lives there, and a future tiebreaker added to
            // it has to reach this path too.
            batchFields = await fieldService.getAll({ projectId, tableId, entityManager })

            await lockExistingRecordIds({ entityManager, ids, projectId, tableId })

            const records = await entityManager.getRepository(RecordEntity).find({
                where: { id: In(ids), projectId, tableId },
                relations: ['cells'],
            })

            await entityManager.getRepository(RecordEntity).delete({ id: In(ids), projectId, tableId })

            return records
        })

        return formatRecordsAndFetchField({ records: deletedRecords, tableId, projectId, fields: batchFields })
    },

    async deleteAll({
        tableId,
        projectId,
        entityManager,
        returnDeleted = true,
    }: DeleteAllParams): Promise<PopulatedRecord[]> {
        const deleteWithManager = async (manager: EntityManager): Promise<RecordSchema[]> => {
            // A caller that discards the result must not pay to build it: at the configured ceiling
            // of 10k records x 100 fields the `cells` relation alone is a million rows, materialised
            // and formatted while this holds the import transaction's connection open.
            if (!returnDeleted) {
                await manager.getRepository(RecordEntity).delete({ projectId, tableId })
                return []
            }

            const records = await manager.getRepository(RecordEntity).find({
                where: { projectId, tableId },
                relations: ['cells'],
            })

            const recordIds = records.map((record) => record.id)

            if (recordIds.length > 0) {
                await manager.getRepository(RecordEntity).delete({
                    id: In(recordIds),
                    projectId,
                    tableId,
                })
            }

            return records
        }

        const deletedRecords = isNil(entityManager)
            ? await transaction(deleteWithManager)
            : await deleteWithManager(entityManager)

        if (deletedRecords.length === 0) {
            return []
        }

        return formatRecordsAndFetchField({ records: deletedRecords, tableId, projectId, entityManager })
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

    async count({ projectId, tableId, entityManager }: CountParams): Promise<number> {
        // The caller's transaction manager when there is one: counting on the default
        // manager from inside a transaction takes a SECOND pool connection while the
        // first is still held, so AP_POSTGRES_POOL_SIZE concurrent upserts deadlock
        // waiting for connections that cannot be issued.
        const repository = isNil(entityManager) ? recordRepo() : entityManager.getRepository(RecordEntity)
        return repository.count({ where: { projectId, tableId } })
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

export type UpsertResult = {
    action: UpsertAction
    record: PopulatedRecord
}

type DeleteParams = {
    tableId: string
    ids: string[]
    projectId: string
}

type DeleteAllParams = {
    tableId: string
    projectId: string
    entityManager?: EntityManager
    returnDeleted?: boolean
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
    entityManager?: EntityManager
}

type RecordInsertion = {
    id: string
    tableId: string
    projectId: string
    created: string
    keyValue: string | null
}

type CellInsertion = {
    id: string
    recordId: string
    fieldId: string
    projectId: string
    value: string
}

// `keyReader` is the same KeyReader upsert() already built from `buildKeyReader` — one
// definition of "key" shared between the legacy upsert path and create() (#409). `null`
// for a table with no declared key, matching today's behaviour exactly.
function prepareRecordInsertions(
    records: Array<Array<{ fieldId: string, value: string | null }>>,
    tableId: string,
    projectId: string,
    baseDate: Date,
    keyReader: KeyReader | null,
): RecordInsertion[] {
    return records.map((cells, index) => {
        const created = new Date(baseDate.getTime() + index).toISOString()
        return {
            tableId,
            projectId,
            created,
            id: apId(),
            keyValue: isNil(keyReader) ? null : keyReader(cells),
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

// The record rows are locked before anything writes or deletes, in ascending id
// order as update()/updateMany()/upsert() all take theirs: an unordered set of row
// locks is how two overlapping batches cycle into a 40P01. Without the lock, a
// batch's existence check and its write are interleavable by a concurrent delete of
// the same rows, and both report success.
//
// Every id is checked, not just the first, and a miss rejects the whole batch rather
// than half-applying it. A record that lives in another table is a miss, not a
// deletion or update target — which is the point: this is where the tableId the
// authorization layer resolved against the request body becomes load-bearing for
// behaviour too (#406). Shared by delete() and updateMany() so the two paths cannot
// drift apart on what "belongs to this table" means.
async function lockExistingRecordIds({ entityManager, ids, projectId, tableId }: { entityManager: EntityManager, ids: string[], projectId: string, tableId: string }): Promise<void> {
    const existingIds = new Set((await entityManager.getRepository(RecordEntity).find({
        where: { id: In(ids), projectId, tableId },
        select: ['id'],
        order: { id: 'ASC' },
        lock: { mode: 'for_no_key_update' },
    })).map((record) => record.id))

    const missingId = ids.find((id) => !existingIds.has(id))
    if (!isNil(missingId)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityType: 'Record', entityId: missingId },
        })
    }
}

function assertKeyFieldsBelongToTable({ keyFieldIds, fieldIds, tableId }: { keyFieldIds: string[], fieldIds: Set<string>, tableId: string }): void {
    const unknown = unique(keyFieldIds.filter((fieldId) => !fieldIds.has(fieldId)))
    if (unknown.length === 0) {
        return
    }
    const message = `Key column(s) not present in table ${tableId}: ${truncateKeyForMessage(unknown.slice(0, MAX_REPORTED_FIELD_IDS).join(', '))}`
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

// The same column twice inside one record is two rows with one conflict target, which
// Postgres answers with a 500 on a body the request schema accepts. updateMany rejects
// it for the same reason; so must this.
function assertNoRepeatedColumn({ records }: { records: { fieldId: string }[][] }): void {
    for (const [index, cells] of records.entries()) {
        const repeated = firstRepeated(cells.map((cellData) => cellData.fieldId))
        if (!isNil(repeated)) {
            const message = `Record #${index + 1} sets column ${repeated} more than once.`
            throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
        }
    }
}

// Two input rows sharing a key would race each other inside one request: the second
// would match what the first just inserted, or not, depending on statement order.
function assertNoRepeatedKey({ records, keyOf }: { records: { fieldId: string, value: unknown }[][], keyOf: KeyReader }): void {
    const repeated = firstRepeated(records.map(keyOf))
    if (isNil(repeated)) {
        return
    }
    const message = `Key ${truncateKeyForMessage(repeated)} appears more than once in the batch. Merge those rows into one.`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// A key is built by concatenating caller-supplied cell values, which the schema does
// not bound. Echoing one whole into an error that is both returned to the caller and
// written to the log makes a 400 an amplification primitive, so it is cut to a length
// that still identifies the offending row.
function truncateKeyForMessage(key: string): string {
    return key.length <= MAX_REPORTED_KEY_LENGTH ? key : `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}…`
}


// One query for the key columns of the whole table, then matched in memory — rather
// than a correlated subquery per input row, which is N round-trips for a batch.
async function indexExistingRecordsByKey({ entityManager, projectId, tableId, keyFieldIds, keyOf }: { entityManager: EntityManager, projectId: string, tableId: string, keyFieldIds: string[], keyOf: KeyReader }): Promise<Map<string, string[]>> {
    const rows = await entityManager.getRepository(RecordEntity).find({ where: { projectId, tableId }, select: ['id'] })
    if (rows.length === 0) {
        return new Map()
    }
    const cells = await entityManager.getRepository(CellEntity).find({
        where: { projectId, fieldId: In(keyFieldIds) },
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

// Recomputes and persists `record.keyValue` for a single record, but only when this
// write actually touches a declared key-field cell (#409) — a write to any other
// column leaves the row's key unchanged, and re-deriving it every time would cost a
// query per write for no reason. The merge (existing key-field cells overlaid by the
// ones this write is setting) uses the exact same `buildKeyReader` the legacy upsert
// path already uses, so there is one definition of "key" across both.
async function recomputeKeyValueIfTouched({ entityManager, projectId, tableId, recordId, keyFieldIds, writtenCells }: { entityManager: EntityManager, projectId: string, tableId: string, recordId: string, keyFieldIds: string[], writtenCells: { fieldId: string, value: string | null }[] }): Promise<void> {
    const keyFieldIdSet = new Set(keyFieldIds)
    const touchesKeyField = writtenCells.some((cell) => keyFieldIdSet.has(cell.fieldId))
    if (!touchesKeyField) {
        return
    }
    const keyValue = await computeKeyValueForRecord({ entityManager, projectId, recordId, keyFieldIds, writtenCells })
    await entityManager.getRepository(RecordEntity).update({ id: recordId, projectId, tableId }, { keyValue })
}

async function computeKeyValueForRecord({ entityManager, projectId, recordId, keyFieldIds, writtenCells }: { entityManager: EntityManager, projectId: string, recordId: string, keyFieldIds: string[], writtenCells: { fieldId: string, value: unknown }[] }): Promise<string> {
    const existingKeyCells = await entityManager.getRepository(CellEntity).find({
        where: { projectId, recordId, fieldId: In(keyFieldIds) },
    })
    const valueByFieldId = new Map<string, unknown>(existingKeyCells.map((cell) => [cell.fieldId, cell.value]))
    for (const cell of writtenCells) {
        if (keyFieldIds.includes(cell.fieldId)) {
            valueByFieldId.set(cell.fieldId, cell.value)
        }
    }
    const mergedCells = keyFieldIds.map((fieldId) => ({ fieldId, value: valueByFieldId.get(fieldId) }))
    return buildKeyReader({ keyFieldIds })(mergedCells)
}

// A table can only be upserted on the key it actually enforces once one is declared
// (#409) — accepting a different `keyFieldIds` from the caller would silently upsert
// on a key the partial unique index does not arbitrate, reintroducing the race the
// declared key exists to close. Order-independent: the caller may list the same
// columns in any order.
function assertRequestKeyMatchesDeclaredKey({ requestKeyFieldIds, declaredKeyFieldIds }: { requestKeyFieldIds: string[], declaredKeyFieldIds: string[] }): void {
    const requested = new Set(requestKeyFieldIds)
    const declared = new Set(declaredKeyFieldIds)
    const matches = requested.size === declared.size && declaredKeyFieldIds.every((fieldId) => requested.has(fieldId))
    if (matches) {
        return
    }
    const message = 'This table has a declared key. keyFieldIds must match it exactly — clear the table\'s key declaration first to upsert on a different key.'
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

// The declared-key upsert path (#409): a real `INSERT ... ON CONFLICT (projectId,
// tableId, keyValue) WHERE keyValue IS NOT NULL DO UPDATE`, arbitrated by the partial
// unique index rather than this process's advisory lock — real per-row concurrency,
// where two overlapping requests racing on the same key resolve at the database
// instead of one blocking behind the other's table-wide lock.
async function upsertWithDeclaredKey({ entityManager, projectId, tableId, keyFieldIds, records }: { entityManager: EntityManager, projectId: string, tableId: string, keyFieldIds: string[], records: { fieldId: string, value: string | null }[][] }): Promise<UpsertResult[]> {
    const existingFields = await entityManager.getRepository(FieldEntity).find({ where: { projectId, tableId } })
    const fieldIds = new Set(existingFields.map((field) => field.id))
    assertKeyFieldsBelongToTable({ keyFieldIds, fieldIds, tableId })

    const validRecords = records.map((cells) => cells.filter((cellData) => fieldIds.has(cellData.fieldId)))
    assertEveryRecordCarriesTheKey({ records: validRecords, keyFieldIds })
    assertNoRepeatedColumn({ records: validRecords })
    const keyOf = buildKeyReader({ keyFieldIds })
    assertNoRepeatedKey({ records: validRecords, keyOf })
    const fieldsById = new Map(existingFields.map((field) => [field.id, field]))
    validRecords.forEach((cells) => assertValidCellValues({ cells, fieldsById }))

    const derivedKeyValues = validRecords.map(keyOf)
    const existingRecords = await entityManager.getRepository(RecordEntity).find({
        where: { projectId, tableId, keyValue: In(unique(derivedKeyValues)) },
        select: ['id', 'keyValue'],
    })
    const existingKeyValues = new Set(existingRecords.map((record) => record.keyValue))

    // Counted with only the rows this batch is actually about to insert, same as the
    // legacy path — a row whose key already exists is an update, not a new row against
    // the cap. Best-effort against a fully concurrent second batch inserting under the
    // same keys: without the advisory lock, two overlapping requests can each pass this
    // check and together land slightly over MAX_RECORDS_PER_TABLE. That is the trade
    // the declared key makes for real per-row concurrency — the ON CONFLICT below is
    // still race-free for correctness, only the cap becomes best-effort under a race.
    const newRowCount = derivedKeyValues.filter((keyValue) => !existingKeyValues.has(keyValue)).length
    if (newRowCount > 0) {
        await recordService.validateCount({ projectId, tableId, entityManager }, newRowCount)
    }

    const now = new Date()
    const insertions: RecordInsertion[] = validRecords.map((_cells, index) => ({
        id: apId(),
        tableId,
        projectId,
        keyValue: derivedKeyValues[index],
        created: new Date(now.getTime() + index).toISOString(),
    }))

    for (const batch of chunk(insertions, MAX_BATCH_SIZE)) {
        await entityManager.createQueryBuilder()
            .insert()
            .into(RecordEntity)
            .values(batch)
            .onConflict('("projectId", "tableId", "keyValue") WHERE "keyValue" IS NOT NULL DO UPDATE SET "updated" = now()')
            .execute()
    }

    // Re-resolved by keyValue rather than trusted from `insertions[index].id`: under a
    // race, ON CONFLICT keeps the WINNING row's original id, which is not the id this
    // process generated for its own (losing) insert attempt. Writing cells against the
    // generated id in that case would attach them to a record that does not exist.
    const winningRecords = await entityManager.getRepository(RecordEntity).find({
        where: { projectId, tableId, keyValue: In(unique(derivedKeyValues)) },
        select: ['id', 'keyValue'],
    })
    const recordIdByKeyValue = new Map(winningRecords.map((record) => [record.keyValue, record.id]))

    const cellsToUpsert = validRecords.flatMap((cells, index) => {
        const recordId = recordIdByKeyValue.get(derivedKeyValues[index])
        return isNil(recordId) ? [] : cells.map((cellData) => ({
            recordId,
            fieldId: cellData.fieldId,
            projectId,
            value: cellData.value ?? '',
            id: apId(),
        }))
    })
    for (const batch of chunk(cellsToUpsert, MAX_BATCH_SIZE)) {
        await entityManager.getRepository(CellEntity).upsert(batch, ['projectId', 'fieldId', 'recordId'])
    }

    const stored = await entityManager.getRepository(RecordEntity).find({
        where: { id: In([...recordIdByKeyValue.values()]), projectId, tableId },
        relations: ['cells'],
    })
    const populated = formatRecords({ records: stored, fields: existingFields })
    const populatedById = new Map(populated.map((record) => [record.id, record]))

    // In input order, matching the legacy path's contract.
    return derivedKeyValues.map((keyValue) => {
        const recordId = recordIdByKeyValue.get(keyValue)
        const record = isNil(recordId) ? undefined : populatedById.get(recordId)
        return isNil(record) ? null : {
            action: existingKeyValues.has(keyValue) ? UpsertAction.UPDATED : UpsertAction.CREATED,
            record,
        }
    }).filter((result): result is UpsertResult => !isNil(result))
}

// Maps a Postgres unique-violation on the keyValue index to a client-facing
// RECORD_DUPLICATE_KEY error, i18n-keyed via formErrors.duplicateKeyValue. Only
// create()/update()/updateMany() can reach this — upsertWithDeclaredKey resolves the
// same collision through ON CONFLICT DO UPDATE instead of raising.
async function withDuplicateKeyMapping<T>(run: () => Promise<T>): Promise<T> {
    // Read off `result` directly rather than destructured into `{ data, error }`: once
    // destructured, TypeScript loses the correlation between the two fields that makes
    // `Result<T, E>` a discriminated union, and narrowing `error` no longer narrows
    // `data` from `T | null` down to `T`.
    const result = await tryCatch(run)
    if (result.error === null) {
        return result.data
    }
    if (isKeyValueUniqueViolation(result.error)) {
        const message = formErrors.duplicateKeyValue
        throw new QadamFlowError({ code: ErrorCode.RECORD_DUPLICATE_KEY, params: { message } }, 'A record with this key value already exists in this table.')
    }
    throw result.error
}

function isKeyValueUniqueViolation(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false
    }
    const driverError = (error as Error & { driverError?: { code?: string, constraint?: string } }).driverError
    return driverError?.code === '23505' && driverError.constraint === KEY_VALUE_UNIQUE_INDEX_NAME
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

async function formatRecordsAndFetchField({ records, tableId, projectId, fields: prefetchedFields, outputFields, entityManager }: { records: RecordSchema[], tableId: string, projectId: string, fields?: Field[], outputFields?: Field[], entityManager?: EntityManager }): Promise<PopulatedRecord[]> {
    const fields = prefetchedFields ?? await fieldService.getAll({
        tableId,
        projectId,
        entityManager,
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

import { ErrorCode, FieldType, isNil, QadamFlowError, SAFE_EXTERNAL_ID_PATTERN, SharedTemplate, Table, TableDataState } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { transaction } from '../core/db/transaction'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { fieldService } from './field/field.service'
import { cellValidation } from './record/cell-validation'
import { recordService } from './record/record.service'
import { tableService } from './table/table.service'

export const tableImportService = {
    async importTemplate({
        projectId,
        template,
        mode,
        existingTableId,
        name,
        maxRecords,
        log,
    }: ImportTemplateParams): Promise<ImportTemplateResult> {
        const tables = template.tables ?? []
        if (tables.length === 0) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'template.tables is missing or empty — nothing to import.' },
            })
        }
        if (tables.length > 1) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'template.tables must contain exactly one table — ap_import_table supports single-table import only.' },
            })
        }
        const tableTemplate = tables[0]
        assertImportableTable(tableTemplate)
        // Before anything destructive runs. importRows() happens AFTER
        // importIntoExistingTable has already committed its clear-and-recreate transaction
        // and cannot join it (recordService.create opens its own), so a row that fails
        // write-time validation there would surface as a 400 with the target table's
        // records and schema already gone. #390 made that reachable: before it there was
        // no cell validation at all, and a template exported before it can legitimately
        // carry a dropdown value that is no longer one of the column's options.
        assertImportableRows(tableTemplate)
        const targetName = name ?? tableTemplate.name

        const created = mode === 'into-existing'
            ? await importIntoExistingTable({ projectId, existingTableId, targetName, tableTemplate })
            : { ...await createTableFromTemplate({ projectId, targetName, tableTemplate }), keyCleared: false }

        const { importedCount, truncated } = await importRows({ projectId, tableId: created.table.id, data: tableTemplate.data, cap: maxRecords, log })

        return { table: created.table, importedCount, truncated, cap: maxRecords, externalIdReplaced: created.externalIdReplaced, keyCleared: created.keyCleared }
    },
}

async function createTableFromTemplate({ projectId, targetName, tableTemplate }: CreateTableFromTemplateParams): Promise<CreatedTable> {
    // The template's externalId is what makes an export portable — a flow that addresses the table by
    // it keeps working after an import into another project. Reusing it inside a project that already
    // has that externalId would instead mint a second table sharing it, and `getOneByExternalIdOrThrow`
    // resolves such a pair arbitrarily, so only the colliding case falls back to a fresh id.
    //
    // Check-then-create, with no unique index on (projectId, externalId) to arbitrate: two imports of
    // the same template racing each other can still both keep it. That narrows the window from always
    // to concurrent-only; closing it needs the index, which is a migration on a populated table and
    // does not belong in this change.
    const collision = await tableService.getOneByExternalIdOrNull({ projectId, externalId: tableTemplate.externalId })
    const externalIdReplaced = !isNil(collision)

    const table = await tableService.create({
        projectId,
        request: {
            projectId,
            name: targetName,
            ...(externalIdReplaced ? {} : { externalId: tableTemplate.externalId }),
            fields: tableTemplate.fields,
        },
    })
    return { table, externalIdReplaced }
}

async function importIntoExistingTable({ projectId, existingTableId, targetName, tableTemplate }: ImportIntoExistingTableParams): Promise<{ table: Table, externalIdReplaced: boolean, keyCleared: boolean }> {
    if (isNil(existingTableId)) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'existingTableId is required when mode is "into-existing".' },
        })
    }
    // Tenant-scoped: throws ENTITY_NOT_FOUND for a table belonging to another project.
    const existingTable = await tableService.getOneOrThrow({ projectId, id: existingTableId })

    // The whole clear-and-recreate-schema sequence runs as one transaction: a failure partway
    // through (createFromState's own assertion, or any other DB error mid-sequence) rolls back
    // the deletes instead of leaving the table wiped, fieldless, and renamed with no way back.
    // Reported back to the caller rather than done quietly: a template carries no key
    // declaration, so an import silently un-enforces a uniqueness guarantee the table had.
    const keyCleared = !isNil(existingTable.keyFieldIds) && existingTable.keyFieldIds.length > 0

    await transaction(async (entityManager: EntityManager) => {
        // Cleared before the old fields are deleted: a declared key (#409) names
        // field ids that are about to stop existing, and fieldService.delete rejects
        // deleting a field that is still part of one. The whole schema is being
        // replaced here, so there is nothing left to declare a key over anyway.
        await tableService.clearKey({ projectId, id: existingTable.id, entityManager })
        await recordService.deleteAll({ tableId: existingTable.id, projectId, entityManager, returnDeleted: false })
        const existingFields = await fieldService.getAll({ projectId, tableId: existingTable.id, entityManager })
        await Promise.all(existingFields.map((field) => fieldService.delete({ id: field.id, projectId, entityManager })))

        await tableService.update({ projectId, id: existingTable.id, request: { name: targetName }, entityManager })
        // Every insert in this transaction would otherwise share one `now()` default, and fields are
        // read back ordered by `created` with no tiebreaker — so the template's column order has to
        // be written into the timestamps to survive the round trip.
        const createdAt = Date.now()
        await Promise.all(tableTemplate.fields.map((field, index) => fieldService.createFromState({ projectId, field, tableId: existingTable.id, entityManager, created: new Date(createdAt + index) })))
    })

    return { table: await tableService.getOneOrThrow({ projectId, id: existingTable.id }), externalIdReplaced: false, keyCleared }
}

async function importRows({ projectId, tableId, data, cap, log }: ImportRowsParams): Promise<{ importedCount: number, truncated: boolean }> {
    const rows = data?.rows ?? []
    if (rows.length === 0) {
        return { importedCount: 0, truncated: false }
    }

    const createdFields = await fieldService.getAll({ projectId, tableId })
    const externalIdToFieldId = new Map(createdFields.map((field) => [field.externalId, field.id]))

    const truncated = rows.length > cap
    const rowsToImport = rows.slice(0, cap)
    const records = rowsToImport.map((row) => mapRowToRecord({ row, externalIdToFieldId }))

    const inserted = await recordService.create({
        request: { tableId, records },
        projectId,
        logger: log,
    })

    return { importedCount: inserted.length, truncated }
}

function mapRowToRecord({ row, externalIdToFieldId }: MapRowToRecordParams): Array<{ fieldId: string, value: string }> {
    return row
        .map((cell) => {
            const fieldId = externalIdToFieldId.get(cell.fieldId)
            return isNil(fieldId) ? null : { fieldId, value: cell.value }
        })
        .filter((cell): cell is { fieldId: string, value: string } => cell !== null)
}

// Runs every template row through the same cell validation the write path applies, using
// the template's own field definitions — the columns do not exist yet, so there is no
// persisted `Field` to look up.
function assertImportableRows(tableTemplate: TableTemplateShape): void {
    const rows = tableTemplate.data?.rows ?? []
    if (rows.length === 0) {
        return
    }
    const fieldByExternalId = new Map(tableTemplate.fields.map((field) => [field.externalId, field]))
    for (const row of rows) {
        for (const cell of row) {
            const field = fieldByExternalId.get(cell.fieldId)
            if (isNil(field)) {
                continue
            }
            const validatable = toValidatableField(field)
            if (isNil(validatable)) {
                continue
            }
            cellValidation.assertValue({ field: validatable, value: cell.value })
        }
    }
}

// `type` is a bare string on the template wire format; assertImportableTable has already
// rejected anything that is not a FieldType by the time this runs, so the null return is
// unreachable rather than a silent skip.
function toValidatableField(field: TableTemplateShape['fields'][number]): ValidatableTemplateField | null {
    switch (field.type) {
        case FieldType.STATIC_DROPDOWN:
            return { name: field.name, type: FieldType.STATIC_DROPDOWN, data: field.data }
        case FieldType.JSON:
            return { name: field.name, type: FieldType.JSON, data: field.data }
        case FieldType.TEXT:
        case FieldType.NUMBER:
        case FieldType.DATE:
        case FieldType.BOOLEAN:
            return { name: field.name, type: field.type }
        default:
            return null
    }
}

function assertImportableTable(tableTemplate: TableTemplateShape): void {
    if (!SAFE_EXTERNAL_ID_PATTERN.test(tableTemplate.externalId)) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: `Table externalId "${tableTemplate.externalId}" is not a safe identifier.` },
        })
    }

    const validTypes = new Set<string>(Object.values(FieldType))
    const maxFields = system.getNumberOrThrow(AppSystemProp.MAX_FIELDS_PER_TABLE)
    if (tableTemplate.fields.length > maxFields) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: `Template has ${tableTemplate.fields.length} fields, exceeding the max of ${maxFields} per table.` },
        })
    }

    for (const field of tableTemplate.fields) {
        if (!validTypes.has(field.type)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Field "${field.name}" has an unsupported type "${field.type}". Supported types: ${Array.from(validTypes).join(', ')}.` },
            })
        }
        if (!SAFE_EXTERNAL_ID_PATTERN.test(field.externalId)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Field "${field.name}" externalId "${field.externalId}" is not a safe identifier.` },
            })
        }
        if (field.type === FieldType.STATIC_DROPDOWN && (isNil(field.data) || isNil(field.data.options) || field.data.options.length === 0)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Field "${field.name}" is STATIC_DROPDOWN but has no dropdown options.` },
            })
        }
    }
}

type TableImportMode = 'create' | 'into-existing'

type ImportTemplateParams = {
    projectId: string
    template: SharedTemplate
    mode: TableImportMode
    existingTableId: string | undefined
    name: string | undefined
    maxRecords: number
    log: FastifyBaseLogger
}

type ImportTemplateResult = {
    table: Table
    importedCount: number
    truncated: boolean
    cap: number
    externalIdReplaced: boolean
    keyCleared: boolean
}

type CreatedTable = {
    table: Table
    externalIdReplaced: boolean
}

type CreateTableFromTemplateParams = {
    projectId: string
    targetName: string
    tableTemplate: NonNullable<SharedTemplate['tables']>[number]
}

type ImportIntoExistingTableParams = {
    projectId: string
    existingTableId: string | undefined
    targetName: string
    tableTemplate: NonNullable<SharedTemplate['tables']>[number]
}

type ImportRowsParams = {
    projectId: string
    tableId: string
    data: TableDataState | null | undefined
    cap: number
    log: FastifyBaseLogger
}

type MapRowToRecordParams = {
    row: TableDataState['rows'][number]
    externalIdToFieldId: Map<string, string>
}

type TableTemplateShape = NonNullable<SharedTemplate['tables']>[number]

type ValidatableTemplateField =
    | { name: string, type: FieldType.STATIC_DROPDOWN, data?: { options?: { value: string }[] } | null }
    | { name: string, type: FieldType.JSON, data?: { schema?: string } | null }
    | { name: string, type: FieldType.TEXT | FieldType.NUMBER | FieldType.DATE | FieldType.BOOLEAN }

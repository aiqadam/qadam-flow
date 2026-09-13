import { ErrorCode, FieldType, isNil, QadamFlowError, SAFE_EXTERNAL_ID_PATTERN, SharedTemplate, Table, TableDataState } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { transaction } from '../core/db/transaction'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { fieldService } from './field/field.service'
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
        const targetName = name ?? tableTemplate.name

        const table = mode === 'into-existing'
            ? await importIntoExistingTable({ projectId, existingTableId, targetName, tableTemplate })
            : await createTableFromTemplate({ projectId, targetName, tableTemplate })

        const { importedCount, truncated } = await importRows({ projectId, tableId: table.id, data: tableTemplate.data, cap: maxRecords, log })

        return { table, importedCount, truncated, cap: maxRecords }
    },
}

async function createTableFromTemplate({ projectId, targetName, tableTemplate }: CreateTableFromTemplateParams): Promise<Table> {
    // The template's externalId is what makes an export portable — a flow that addresses the table by
    // it keeps working after an import into another project. Reusing it inside a project that already
    // has that externalId would instead mint a second table sharing it, and `getOneByExternalIdOrThrow`
    // resolves such a pair arbitrarily, so only the colliding case falls back to a fresh id.
    const collision = await tableService.getOneByExternalIdOrNull({ projectId, externalId: tableTemplate.externalId })

    return tableService.create({
        projectId,
        request: {
            projectId,
            name: targetName,
            ...(isNil(collision) ? { externalId: tableTemplate.externalId } : {}),
            fields: tableTemplate.fields,
        },
    })
}

async function importIntoExistingTable({ projectId, existingTableId, targetName, tableTemplate }: ImportIntoExistingTableParams): Promise<Table> {
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
    await transaction(async (entityManager: EntityManager) => {
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

    return tableService.getOneOrThrow({ projectId, id: existingTable.id })
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

function assertImportableTable(tableTemplate: NonNullable<SharedTemplate['tables']>[number]): void {
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
        if (field.type === FieldType.STATIC_DROPDOWN && (isNil(field.data) || field.data.options.length === 0)) {
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

import { FilterOperator, McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { recordService } from '../../tables/record/record.service'
import { mcpUtils } from './mcp-utils'
import { formatPopulatedRecord, resolveFieldNamesForTable } from './table-utils'

const OPERATOR_VALUES = [
    FilterOperator.EQ,
    FilterOperator.NEQ,
    FilterOperator.GT,
    FilterOperator.GTE,
    FilterOperator.LT,
    FilterOperator.LTE,
    FilterOperator.CO,
    FilterOperator.IN,
    FilterOperator.NOT_IN,
    FilterOperator.EXISTS,
    FilterOperator.NOT_EXISTS,
] as const

const operatorSchema = z.enum(OPERATOR_VALUES)

// in/not_in take a comma-separated value from the agent.
function splitListValue(value: string): string[] {
    return value.split(',').map(part => part.trim()).filter(part => part.length > 0)
}

const findRecordsInput = z.object({
    tableId: z.string().describe('The table ID. Use ap_list_tables to find it.'),
    filters: z.array(z.object({
        fieldName: z.string().describe('The field name to filter on'),
        operator: operatorSchema.describe('Filter operator'),
        value: z.string().optional().describe('Filter value (required for all operators except exists/not_exists). For in/not_in, pass a comma-separated list. gt/gte/lt/lte compare by column type: NUMBER numerically, DATE by parsed timestamp (ISO, not epoch milliseconds), TEXT and STATIC_DROPDOWN alphabetically ignoring case. A DATE value with no time names the whole UTC day, so `lte 2026-09-11` includes rows dated the 11th.'),
    })).optional().describe('Optional filters. All filters are combined with AND logic.'),
    columns: z.array(z.string()).min(1).optional().describe('Optional column names to return. Omit to return every column. Naming a column the table does not have is an error, not a silent widening back to every column.'),
    limit: z.number().min(1).max(500).optional().describe('Max records to return (default 50, max 500)'),
})

export const apFindRecordsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_find_records',
        permission: Permission.READ_TABLE,
        description: 'Query records from a table with optional filtering. Operators: eq, neq, gt, gte, lt, lte, co, in, not_in, exists, not_exists. Range operators respect the column type; a value the column type cannot interpret is rejected rather than returning an empty result. Pass `columns` to return only the columns you need — every column returned is written verbatim into the run log.',
        inputSchema: findRecordsInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { tableId, filters, columns, limit } = findRecordsInput.parse(args)
                const effectiveLimit = limit ?? 50

                let resolvedFilters = null
                let fieldIds: string[] | undefined = undefined
                let fields = undefined
                if ((filters && filters.length > 0) || (columns && columns.length > 0)) {
                    const fieldNames = [...(filters ?? []).map(f => f.fieldName), ...(columns ?? [])]
                    const resolved = await resolveFieldNamesForTable(mcp.projectId, tableId, fieldNames)
                    fields = resolved.fields

                    for (const filter of filters ?? []) {
                        const isListOp = filter.operator === FilterOperator.IN || filter.operator === FilterOperator.NOT_IN
                        const isExistenceOp = filter.operator === FilterOperator.EXISTS || filter.operator === FilterOperator.NOT_EXISTS
                        if (!isExistenceOp && filter.value === undefined) {
                            resolved.errors.push(`Filter on "${filter.fieldName}" with operator "${filter.operator}" requires a value.`)
                        }
                        else if (isListOp && filter.value !== undefined && splitListValue(filter.value).length === 0) {
                            resolved.errors.push(`Filter on "${filter.fieldName}" with operator "${filter.operator}" requires at least one value.`)
                        }
                    }

                    if (resolved.errors.length > 0) {
                        return { content: [{ type: 'text', text: `❌ Error:\n${resolved.errors.join('\n')}` }] }
                    }

                    // Every name resolved, or the error gate above already returned.
                    fieldIds = columns?.flatMap(column => {
                        const fieldId = resolved.fieldMap.get(column)
                        return fieldId === undefined ? [] : [fieldId]
                    })
                    resolvedFilters = filters === undefined || filters.length === 0 ? null : filters.map(f => {
                        const fieldId = resolved.fieldMap.get(f.fieldName)!
                        if (f.operator === FilterOperator.EXISTS || f.operator === FilterOperator.NOT_EXISTS) {
                            return { fieldId, operator: f.operator }
                        }
                        if (f.operator === FilterOperator.IN || f.operator === FilterOperator.NOT_IN) {
                            return { fieldId, operator: f.operator, value: splitListValue(f.value!) }
                        }
                        return { fieldId, operator: f.operator, value: f.value! }
                    })
                }

                const result = await recordService.list({
                    tableId,
                    projectId: mcp.projectId,
                    filters: resolvedFilters,
                    limit: effectiveLimit,
                    cursorRequest: null,
                    fieldIds,
                    fields,
                })

                if (result.data.length === 0) {
                    return {
                        content: [{ type: 'text', text: 'No records found.' }],
                        structuredContent: { records: [], count: 0 },
                    }
                }

                const formatted = result.data.map(r => formatPopulatedRecord(r)).join('\n\n')
                const structured = {
                    records: result.data.map(r => ({
                        id: r.id,
                        cells: Object.fromEntries(
                            Object.entries(r.cells).map(([fieldId, c]) => [c.fieldName ?? fieldId, c.value]),
                        ),
                    })),
                    count: result.data.length,
                }
                return {
                    content: [{
                        type: 'text',
                        text: `Found ${result.data.length} record(s):\n\n${formatted}`,
                    }],
                    structuredContent: structured,
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_find_records failed')
                return mcpUtils.mcpToolError('Failed to find records', err)
            }
        },
    }
}

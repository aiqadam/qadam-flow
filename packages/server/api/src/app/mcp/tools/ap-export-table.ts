import { McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { recordService } from '../../tables/record/record.service'
import { tableService } from '../../tables/table/table.service'
import { mcpUtils } from './mcp-utils'

const EXPORT_TABLE_ROW_CAP = 500

const exportTableInput = z.object({
    tableId: z.string(),
    includeRecords: z.boolean().optional().describe('When true, include row data (capped at 500 rows). Defaults to false (schema only).'),
})

export const apExportTableTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_export_table',
        permission: Permission.READ_TABLE,
        description: 'Export a table as a SharedTemplate JSON: schema (fields) and, optionally, row data. Row data is capped at 500 rows to keep the response within a model context window — use ap_find_records for a specific slice of a larger table. Use ap_import_table to re-apply it, in this project or another one.',
        inputSchema: exportTableInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { tableId, includeRecords } = exportTableInput.parse(args)

                // Schema-only requests (the default) skip the record fetch entirely — the
                // service never loads a row or cell for them.
                const template = await tableService.getTemplate({
                    tableId,
                    userMetadata: null,
                    projectId: mcp.projectId,
                    includeRecords: Boolean(includeRecords),
                    maxRecords: EXPORT_TABLE_ROW_CAP,
                })
                const tableTemplate = template.tables?.[0]
                if (!tableTemplate) {
                    return { content: [{ type: 'text', text: '❌ Table not found or has no exportable schema.' }] }
                }

                if (!includeRecords) {
                    return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] }
                }

                const totalRowCount = await recordService.count({ projectId: mcp.projectId, tableId })
                const truncated = totalRowCount > EXPORT_TABLE_ROW_CAP

                const truncationNote = truncated
                    ? `\n\n⚠️ truncated to ${EXPORT_TABLE_ROW_CAP} of ${totalRowCount} rows`
                    : ''

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(template, null, 2) + truncationNote,
                    }],
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_export_table failed')
                return mcpUtils.mcpToolError('Failed to export table', err)
            }
        },
    }
}

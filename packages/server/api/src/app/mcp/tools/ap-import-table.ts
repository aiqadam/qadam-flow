import { McpToolDefinition, Permission, ProjectScopedMcpServer, SharedTemplate } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { tableImportService } from '../../tables/table-import.service'
import { mcpUtils } from './mcp-utils'

const IMPORT_TABLE_ROW_CAP = 1000

const importTableInput = z.object({
    template: z.record(z.string(), z.unknown()).describe('A SharedTemplate JSON object, as produced by ap_export_table — must contain a single-entry "tables" array.'),
    name: z.string().optional().describe('Name for the imported table. Defaults to the template\'s table name.'),
    mode: z.enum(['create', 'into-existing']).describe('"create" makes a new table. "into-existing" clears existingTableId and replaces its schema and data.'),
    existingTableId: z.string().optional().describe('Required when mode is "into-existing" — the table to clear and overwrite.'),
})

export const apImportTableTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_import_table',
        permission: Permission.WRITE_TABLE,
        description: `Import a table from a SharedTemplate JSON (as produced by ap_export_table). "create" makes a new table; "into-existing" clears an existing table (schema and data) and replaces it. Row data is capped at ${IMPORT_TABLE_ROW_CAP} rows.`,
        inputSchema: importTableInput.shape,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { template, name, mode, existingTableId } = importTableInput.parse(args)

                if (mode === 'into-existing' && !existingTableId) {
                    return { content: [{ type: 'text', text: '❌ existingTableId is required when mode is "into-existing".' }] }
                }

                const parsed = SharedTemplate.safeParse(template)
                if (!parsed.success) {
                    return { content: [{ type: 'text', text: `❌ template does not match the SharedTemplate shape: ${parsed.error.message}` }] }
                }

                const result = await tableImportService.importTemplate({
                    projectId: mcp.projectId,
                    template: parsed.data,
                    mode,
                    existingTableId,
                    name,
                    maxRecords: IMPORT_TABLE_ROW_CAP,
                    log,
                })

                const truncationNote = result.truncated
                    ? `\n⚠️ truncated to ${result.cap} rows — the template contained more rows than the import cap.`
                    : ''

                return {
                    content: [{
                        type: 'text',
                        text: `✅ Table "${result.table.name}" (id: ${result.table.id}) imported. ${result.importedCount} row(s) inserted.${truncationNote}`,
                    }],
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_import_table failed')
                return mcpUtils.mcpToolError('Failed to import table', err)
            }
        },
    }
}

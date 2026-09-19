import { apId, FieldType, isNil, MAX_KEY_FIELDS, McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { fieldService } from '../../tables/field/field.service'
import { tableService } from '../../tables/table/table.service'
import { mcpUtils } from './mcp-utils'
import { fieldTypeSchema, formatFieldInfo } from './table-utils'

const createTableInput = z.object({
    name: z.string().describe('The name of the table'),
    fields: z.array(z.object({
        name: z.string().describe('Field name'),
        type: fieldTypeSchema.describe('Field type'),
        options: z.array(z.string()).optional().describe('Dropdown options (required when type is STATIC_DROPDOWN)'),
    })).describe('Fields to create. Max 100 fields per table.'),
    // #409. Field NAMES, not ids — the ids do not exist yet at this point in the call.
    // Declaring a key on brand-new fields never collides (there are no records yet),
    // so this always succeeds if the names resolve.
    keyFields: z.array(z.string()).max(MAX_KEY_FIELDS).optional().describe('Field names (from `fields` above) that together form this table\'s unique business key. Optional — omit for no key.'),
})

export const apCreateTableTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_create_table',
        permission: Permission.WRITE_TABLE,
        description: 'Create a new table with an initial set of fields. Types: TEXT, NUMBER, DATE, STATIC_DROPDOWN.',
        inputSchema: createTableInput.shape,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { name, fields, keyFields } = createTableInput.parse(args)

                for (const field of fields) {
                    if (field.type === FieldType.STATIC_DROPDOWN && (!field.options || field.options.length === 0)) {
                        return { content: [{ type: 'text', text: `❌ Field "${field.name}" is STATIC_DROPDOWN but no options provided.` }] }
                    }
                }

                if (!isNil(keyFields) && keyFields.length > 0) {
                    const unknownKeyFields = keyFields.filter((keyField) => !fields.some((field) => field.name === keyField))
                    if (unknownKeyFields.length > 0) {
                        return { content: [{ type: 'text', text: `❌ keyFields names field(s) not present in \`fields\`: ${unknownKeyFields.join(', ')}` }] }
                    }
                }

                const fieldStates = fields.map(f => ({
                    name: f.name,
                    type: f.type,
                    externalId: apId(),
                    data: f.type === FieldType.STATIC_DROPDOWN
                        ? { options: (f.options ?? []).map(v => ({ value: v })) }
                        : null,
                }))

                const table = await tableService.create({
                    projectId: mcp.projectId,
                    request: {
                        projectId: mcp.projectId,
                        name,
                        fields: fieldStates,
                    },
                })

                const createdFields = await fieldService.getAll({
                    projectId: mcp.projectId,
                    tableId: table.id,
                })

                let keyLine = ''
                if (!isNil(keyFields) && keyFields.length > 0) {
                    const keyFieldIds = keyFields.map((keyField) => createdFields.find((field) => field.name === keyField)?.id).filter((id): id is string => !isNil(id))
                    // Declaring a partial key because a name failed to resolve would be
                    // worse than failing: the table would silently enforce uniqueness on
                    // fewer columns than the caller asked for. The name check above makes
                    // this unreachable unless two fields share a name.
                    if (keyFieldIds.length !== keyFields.length) {
                        return { content: [{ type: 'text', text: `❌ Table "${name}" was created (id: ${table.id}) but its key was not declared: field names in \`keyFields\` must each match exactly one field. Declare it with ap_manage_fields DECLARE_KEY.` }] }
                    }
                    await tableService.declareKey({ projectId: mcp.projectId, id: table.id, keyFieldIds })
                    keyLine = `\nKey: ${keyFields.join(', ')}`
                }

                const fieldLines = createdFields.map(f => `  - ${formatFieldInfo(f)}`).join('\n')
                return {
                    content: [{
                        type: 'text',
                        text: `✅ Table "${name}" created (id: ${table.id})\nFields:\n${fieldLines}${keyLine}`,
                    }],
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_create_table failed')
                return mcpUtils.mcpToolError('Failed to create table', err)
            }
        },
    }
}

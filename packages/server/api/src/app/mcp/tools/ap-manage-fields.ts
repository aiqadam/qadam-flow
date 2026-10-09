import { Field, FieldType, isNil, MAX_KEY_FIELDS, McpToolDefinition, Permission, ProjectScopedMcpServer, spreadIfDefined } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { fieldService } from '../../tables/field/field.service'
import { tableService } from '../../tables/table/table.service'
import { mcpUtils } from './mcp-utils'
import { fieldTypeSchema, formatFieldInfo } from './table-utils'

const manageFieldsInput = z.object({
    tableId: z.string().describe('The table ID'),
    operation: z.enum(['ADD', 'UPDATE', 'DELETE', 'DECLARE_KEY', 'CLEAR_KEY']).describe('ADD a new field, UPDATE an existing field (rename it and/or replace a STATIC_DROPDOWN\'s options in place), DELETE a field, DECLARE_KEY to set the table\'s unique business key (#409), or CLEAR_KEY to remove it'),
    fieldId: z.string().optional().describe('The field ID (required for UPDATE and DELETE). Use ap_list_tables to find it.'),
    name: z.string().optional().describe('Field name (required for ADD; for UPDATE the new name — give name, options, or both)'),
    type: fieldTypeSchema.optional().describe('Field type (required for ADD only)'),
    options: z.array(z.string()).optional().describe('Dropdown options (required for ADD with STATIC_DROPDOWN type). For UPDATE on a STATIC_DROPDOWN field this is the complete new list: new values are added, and the field id, externalId and existing cells are kept. An option still used by a record cannot be removed (a rename counts as a removal) — clear or change those cells first.'),
    keyFieldIds: z.array(z.string()).max(MAX_KEY_FIELDS).optional().describe('Field IDs that together form the table\'s unique business key (required for DECLARE_KEY). A field that is part of the current key cannot be deleted until CLEAR_KEY runs first.'),
})

export const apManageFieldsTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_manage_fields',
        permission: Permission.WRITE_TABLE,
        description: 'Add, rename, change the dropdown options of, or delete fields on a table. Max 100 fields per table.',
        inputSchema: manageFieldsInput.shape,
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { tableId, operation, fieldId, name, type, options, keyFieldIds } = manageFieldsInput.parse(args)

                switch (operation) {
                    case 'DECLARE_KEY': {
                        if (isNil(keyFieldIds) || keyFieldIds.length === 0) {
                            return { content: [{ type: 'text', text: '❌ keyFieldIds is required for DECLARE_KEY operation' }] }
                        }
                        const table = await tableService.declareKey({ projectId: mcp.projectId, id: tableId, keyFieldIds })
                        return { content: [{ type: 'text', text: `✅ Key declared on table ${mcpUtils.wrapUntrustedValue(table.name)}: ${table.keyFieldIds?.join(', ')}` }] }
                    }
                    case 'CLEAR_KEY': {
                        const table = await tableService.clearKey({ projectId: mcp.projectId, id: tableId })
                        return { content: [{ type: 'text', text: `✅ Key cleared on table ${mcpUtils.wrapUntrustedValue(table.name)}` }] }
                    }
                    case 'ADD': {
                        if (isNil(name)) {
                            return { content: [{ type: 'text', text: '❌ name is required for ADD operation' }] }
                        }
                        if (isNil(type)) {
                            return { content: [{ type: 'text', text: '❌ type is required for ADD operation' }] }
                        }
                        if (type === FieldType.STATIC_DROPDOWN && (isNil(options) || options.length === 0)) {
                            return { content: [{ type: 'text', text: '❌ options are required for STATIC_DROPDOWN type' }] }
                        }

                        const request = type === FieldType.STATIC_DROPDOWN
                            ? { name, type, tableId, data: { options: (options ?? []).map(v => ({ value: v })) } }
                            : { name, type, tableId }

                        const field = await fieldService.create({
                            projectId: mcp.projectId,
                            request,
                        })
                        return { content: [{ type: 'text', text: `✅ Field added: ${formatFieldInfo(field)}` }] }
                    }
                    case 'UPDATE': {
                        if (isNil(fieldId)) {
                            return { content: [{ type: 'text', text: '❌ fieldId is required for UPDATE operation' }] }
                        }
                        if (isNil(name) && isNil(options)) {
                            return { content: [{ type: 'text', text: '❌ name or options is required for UPDATE operation' }] }
                        }
                        const existing = await fieldService.getById({ id: fieldId, projectId: mcp.projectId })
                        if (existing.tableId !== tableId) {
                            return { content: [{ type: 'text', text: `❌ Field (id: ${fieldId}) does not belong to table (id: ${tableId})` }] }
                        }
                        const field = await fieldService.update({
                            id: fieldId,
                            projectId: mcp.projectId,
                            request: {
                                ...spreadIfDefined('name', name),
                                ...spreadIfDefined('data', isNil(options) ? undefined : { options: options.map(value => ({ value })) }),
                            },
                        })
                        return { content: [{ type: 'text', text: `✅ Field updated (${describeFieldChanges({ before: existing, after: field }).join('; ')}): ${formatFieldInfo(field)}` }] }
                    }
                    case 'DELETE': {
                        if (isNil(fieldId)) {
                            return { content: [{ type: 'text', text: '❌ fieldId is required for DELETE operation' }] }
                        }
                        const toDelete = await fieldService.getById({ id: fieldId, projectId: mcp.projectId })
                        if (toDelete.tableId !== tableId) {
                            return { content: [{ type: 'text', text: `❌ Field (id: ${fieldId}) does not belong to table (id: ${tableId})` }] }
                        }
                        await fieldService.delete({
                            id: fieldId,
                            projectId: mcp.projectId,
                        })
                        return { content: [{ type: 'text', text: `✅ Field ${mcpUtils.wrapUntrustedValue(toDelete.name)} deleted successfully.` }] }
                    }
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_manage_fields failed')
                return mcpUtils.mcpToolError('Field operation failed', err)
            }
        },
    }
}

function describeFieldChanges({ before, after }: { before: Field, after: Field }): string[] {
    const nameChange = before.name === after.name ? [] : [`renamed from ${mcpUtils.wrapUntrustedValue(before.name)}`]
    const optionChange = before.type === FieldType.STATIC_DROPDOWN && after.type === FieldType.STATIC_DROPDOWN
        ? describeOptionChange({ before: before.data.options, after: after.data.options })
        : []
    const changes = [...nameChange, ...optionChange]
    return changes.length === 0 ? ['no changes'] : changes
}

function describeOptionChange({ before, after }: { before: { value: string }[], after: { value: string }[] }): string[] {
    const beforeValues = new Set(before.map(option => option.value))
    const afterValues = new Set(after.map(option => option.value))
    const added = after.filter(option => !beforeValues.has(option.value)).map(option => mcpUtils.wrapUntrustedValue(option.value))
    const removed = before.filter(option => !afterValues.has(option.value)).map(option => mcpUtils.wrapUntrustedValue(option.value))
    return [
        ...(added.length > 0 ? [`options added: ${added.join(', ')}`] : []),
        ...(removed.length > 0 ? [`options removed: ${removed.join(', ')}`] : []),
    ]
}

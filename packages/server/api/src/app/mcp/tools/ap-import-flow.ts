import {
    FlowCreatorType,
    FlowOperationType,
    FlowVersionTemplate,
    isNil,
    McpToolContext,
    McpToolDefinition,
    Permission,
    SharedTemplate,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { projectService } from '../../project/project-service'
import { mcpUtils } from './mcp-utils'

const importFlowInput = z.object({
    template: z.record(z.string(), z.unknown()).describe('A SharedTemplate JSON object, as produced by ap_export_flow — must contain a single-entry "flows" array.'),
    flowId: z.string().optional().describe('If provided, overwrites this flow\'s draft with the template. Omit to create a new flow.'),
})

export const apImportFlowTool = ({ mcp, userId }: McpToolContext, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_import_flow',
        permission: Permission.WRITE_FLOW,
        description: 'Import a flow from a SharedTemplate JSON (as produced by ap_export_flow). With flowId, overwrites that flow\'s draft; without it, creates a new flow. Connections referenced by the template must be re-configured after import (step auth inputs are cleared by export).',
        inputSchema: importFlowInput.shape,
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
        execute: async (args) => {
            try {
                const { template, flowId } = importFlowInput.parse(args)

                const validated = validateTemplateShape(template)
                if (!validated.ok) {
                    return { content: [{ type: 'text', text: `❌ ${validated.error}` }] }
                }
                const { name, flowTemplate } = validated

                const project = await projectService(log).getOneOrThrow(mcp.projectId)

                const operation: ImportFlowOperation = {
                    type: FlowOperationType.IMPORT_FLOW,
                    request: {
                        displayName: name,
                        trigger: flowTemplate.trigger,
                        schemaVersion: flowTemplate.schemaVersion ?? null,
                        notes: flowTemplate.notes ?? null,
                        localeSource: flowTemplate.localeSource ?? null,
                    },
                }

                if (!isNil(flowId)) {
                    const existingFlow = await flowService(log).getOnePopulated({ id: flowId, projectId: mcp.projectId })
                    if (isNil(existingFlow)) {
                        return { content: [{ type: 'text', text: '❌ Flow not found' }] }
                    }

                    const updatedFlow = await flowService(log).update({
                        id: flowId,
                        projectId: mcp.projectId,
                        userId: null,
                        platformId: project.platformId,
                        operation,
                    })
                    return {
                        content: [{
                            type: 'text',
                            text: `✅ Flow "${mcpUtils.wrapUntrustedValue(updatedFlow.version.displayName)}" (id: ${updatedFlow.id}) overwritten from template.\n\nNote: Connections are not restored — step auth inputs are cleared by export, so use ap_flow_structure to check configuration status and re-configure steps as needed.`,
                        }],
                    }
                }

                const newFlow = await flowService(log).create({
                    projectId: mcp.projectId,
                    ownerId: userId,
                    createdBy: { type: FlowCreatorType.MCP, id: mcp.id },
                    request: {
                        displayName: name,
                        projectId: mcp.projectId,
                    },
                })

                try {
                    const importedFlow = await flowService(log).update({
                        id: newFlow.id,
                        projectId: mcp.projectId,
                        userId: null,
                        platformId: project.platformId,
                        operation,
                    })
                    return {
                        content: [{
                            type: 'text',
                            text: `✅ Flow "${mcpUtils.wrapUntrustedValue(importedFlow.version.displayName)}" (id: ${importedFlow.id}) created from template.\n\nNote: Connections are not restored — step auth inputs are cleared by export, so use ap_flow_structure to check configuration status and re-configure steps as needed.`,
                        }],
                    }
                }
                catch (importErr) {
                    try {
                        await flowService(log).delete({ id: newFlow.id, projectId: mcp.projectId })
                    }
                    catch (cleanupErr) {
                        log.warn({ cleanupErr, flowId: newFlow.id, projectId: mcp.projectId }, 'ap_import_flow: failed to roll back orphaned flow after a failed import')
                    }
                    log.error({ err: importErr, projectId: mcp.projectId }, 'ap_import_flow failed')
                    return mcpUtils.mcpToolError('Flow import failed', importErr)
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_import_flow failed')
                return mcpUtils.mcpToolError('Flow import failed', err)
            }
        },
    }
}

function validateTemplateShape(template: Record<string, unknown>): ValidateTemplateShapeResult {
    const parsed = SharedTemplate.safeParse(template)
    if (!parsed.success) {
        return { ok: false, error: `template does not match the SharedTemplate shape: ${parsed.error.message}` }
    }
    const flows = parsed.data.flows ?? []
    if (flows.length === 0) {
        return { ok: false, error: 'template.flows is missing or empty. ap_import_flow only accepts a template exported by ap_export_flow.' }
    }
    if (flows.length > 1) {
        return { ok: false, error: 'template.flows must contain exactly one flow — ap_import_flow supports single-flow import only.' }
    }
    return { ok: true, name: parsed.data.name, flowTemplate: flows[0] }
}

type ImportFlowOperation = {
    type: FlowOperationType.IMPORT_FLOW
    request: {
        displayName: string
        trigger: FlowVersionTemplate['trigger']
        schemaVersion: string | null
        notes: FlowVersionTemplate['notes'] | null
        localeSource: FlowVersionTemplate['localeSource']
    }
}

type ValidateTemplateShapeResult =
    | { ok: true, name: string, flowTemplate: FlowVersionTemplate }
    | { ok: false, error: string }

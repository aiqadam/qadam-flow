import { ExportedUnresolvedStep, McpToolDefinition, Permission, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { snapshotPinExport } from '../../qadams/snapshot-export/snapshot-pin-export'
import { mcpUtils } from './mcp-utils'

const exportFlowInput = z.object({
    flowId: z.string(),
    keepSnapshots: z.boolean().optional().describe('Keep pre-release (-main.<n>) qadam pins as they are and embed each one\'s metadata.json, for an instance that runs the same snapshots. Omit it to get a release pin instead.'),
})

export const apExportFlowTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_export_flow',
        permission: Permission.READ_FLOW,
        description: 'Export a flow as a SharedTemplate JSON, the same shape used by the flow templates gallery. Never contains a connection value or variable value — no secret is ever included. Step inputs that reference a connection are cleared, but the flow-level list of referenced connection ids is retained as-is; sample data is stripped. A pre-release (-main.<n>) qadam pin is rewritten to the newest release that is compatible with it; a step with no such release is exported as ^<base>, listed in the result and marked "update this step" on import. Use ap_import_flow to re-apply it, in this project or another one.',
        inputSchema: exportFlowInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { flowId, keepSnapshots } = exportFlowInput.parse(args)

                const template = await flowService(log).getTemplate({
                    flowId,
                    projectId: mcp.projectId,
                    userMetadata: null,
                    versionId: undefined,
                    snapshotExportMode: snapshotPinExport.modeFor({ sameInstance: false, keepSnapshots }),
                })

                const flagged = (template.flows ?? []).flatMap((flow) => flow.exportedUnresolved ?? [])
                return {
                    content: [
                        { type: 'text', text: JSON.stringify(template, null, 2) },
                        ...(flagged.length === 0 ? [] : [{ type: 'text' as const, text: describeFlaggedSteps({ flagged }) }]),
                    ],
                }
            }
            catch (err) {
                log.error({ err, projectId: mcp.projectId }, 'ap_export_flow failed')
                return mcpUtils.mcpToolError('Failed to export flow', err)
            }
        },
    }
}

function describeFlaggedSteps({ flagged }: { flagged: ExportedUnresolvedStep[] }): string {
    const lines = flagged.map((step) => `- ${mcpUtils.wrapUntrustedValue(step.stepName)}: ${mcpUtils.wrapUntrustedValue(step.qadamName)} was pinned to ${mcpUtils.wrapUntrustedValue(step.pin)}, a pre-release build; no release passed the props check, so it is exported as a caret range of its base release`)
    return `${flagged.length} step(s) could not be moved to a release and will be marked "update this step" when the flow is imported:\n${lines.join('\n')}`
}

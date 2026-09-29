import {
    FlowOperationType,
    formErrors,
    isNil,
    LOCALE_SOURCE_MAX_LENGTH,
    McpToolDefinition,
    Permission,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { projectService } from '../../project/project-service'
import { mcpUtils } from './mcp-utils'

const updateLocaleSourceInput = z.object({
    flowId: z.string(),
    // Trimmed before the length check, as the builder's Locale settings dialog does.
    localeSource: z.string().transform((value) => value.trim()).pipe(z.string().max(LOCALE_SOURCE_MAX_LENGTH, formErrors.localeSourceTooLong)).nullable(),
})

export const apUpdateLocaleSourceTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_update_locale_source',
        permission: Permission.WRITE_FLOW,
        description: 'Set or clear a flow\'s localeSource: the expression evaluated once per run to pick the locale its {{$t[...]}} references resolve in, and the locale every callFlow child inherits. Changes only this field on the draft (no export/import round-trip, step auth stays intact); publish with ap_lock_and_publish for runs to use it. ap_flow_structure shows the current value.',
        inputSchema: {
            flowId: z.string().describe('The id of the flow'),
            localeSource: z.string().nullable().describe(`At most ${LOCALE_SOURCE_MAX_LENGTH} characters after trimming. A template such as {{trigger[\'output\'].message.from.language_code}}, or a fixed locale such as ru. null or an empty string clears it, so runs fall back to the inherited locale, then the project default locale.`),
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            const { flowId, localeSource } = updateLocaleSourceInput.parse(args)
            // Blank means "no override", the same as in the builder's Locale settings dialog.
            const normalized = isNil(localeSource) || localeSource.length === 0 ? null : localeSource

            const [flow, project] = await Promise.all([
                flowService(log).getOnePopulated({ id: flowId, projectId: mcp.projectId }),
                projectService(log).getOneOrThrow(mcp.projectId),
            ])
            if (isNil(flow)) {
                return { content: [{ type: 'text', text: '❌ Flow not found' }] }
            }

            try {
                await flowService(log).update({
                    id: flow.id,
                    projectId: mcp.projectId,
                    userId: null,
                    platformId: project.platformId,
                    operation: {
                        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
                        request: { localeSource: normalized },
                    },
                })
                const previous = flow.version.localeSource ?? null
                const summary = isNil(normalized)
                    ? '✅ localeSource cleared on the draft.'
                    : `✅ localeSource set to ${mcpUtils.wrapUntrustedValue(normalized)} on the draft.`
                return {
                    content: [{
                        type: 'text',
                        text: `${summary} Previous value: ${isNil(previous) ? 'none' : mcpUtils.wrapUntrustedValue(previous)}. Publish with ap_lock_and_publish for runs to use it.`,
                    }],
                    structuredContent: { flowId: flow.id, localeSource: normalized, previousLocaleSource: previous },
                }
            }
            catch (err) {
                return mcpUtils.mcpToolError('Updating localeSource failed', err)
            }
        },
    }
}

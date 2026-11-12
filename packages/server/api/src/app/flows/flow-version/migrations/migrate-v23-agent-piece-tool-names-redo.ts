import {
    AgentQadamProps,
    AgentToolType,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
    mcpToolNameUtils,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { Migration } from '.'

// v16 was supposed to rename agent PIECE tool names. It read `tool.qadamMetadata`, a field no
// producer has ever written — the schema calls it `pieceMetadata` — so the condition was always
// false and every PIECE tool fell through untouched. Optional chaining meant it did not throw and
// nothing logged, so the migration reported success while doing nothing for the tool type named in
// its own filename (#247).
//
// Fixing v16 alone does not help anyone who already has it: `schemaVersion` records it as done and
// it never runs again. This redoes just its PIECE branch for those versions. The FLOW and MCP
// branches worked and are deliberately not repeated — re-running `createToolName` on an
// already-renamed FLOW tool would rename it a second time.
//
// Safe to apply twice: `createQadamToolName` is a pure function of the qadam name and action name,
// so a tool that already carries the right name gets the same string back.
export const migrateV23AgentQadamToolNamesRedo: Migration = {
    targetSchemaVersion: '23',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== '@aiqadam/qadam-ai' || step.settings.actionName !== 'run_agent') {
                return step
            }

            const rawTools = step.settings.input?.[AgentQadamProps.AGENT_TOOLS]
            // `input` is `z.record(z.string(), z.unknown())` — nothing upstream guarantees
            // `agentTools` is an array. A non-array here would throw on `.map` below, which
            // `flowVersionMigrationService.migrate` rethrows and pages on-call for, 500ing every
            // read of that one flow version. Treat it as nothing to migrate instead (#1028).
            if (!isNil(rawTools) && !Array.isArray(rawTools)) {
                system.globalLogger().warn({ flowVersionId: flowVersion.id, stepName: step.name }, '[migrateV23AgentQadamToolNamesRedo] skipping step with a non-array agentTools input')
                return step
            }
            const tools = (rawTools as AgentToolInput[] | undefined) ?? []
            const newTools = tools.map((tool) => {
                if (tool.type !== AgentToolType.PIECE) {
                    return tool
                }
                if (tool.pieceMetadata?.qadamName == null || tool.pieceMetadata?.actionName == null) {
                    return tool
                }
                return {
                    ...tool,
                    toolName: mcpToolNameUtils.createQadamToolName(tool.pieceMetadata.qadamName, tool.pieceMetadata.actionName),
                }
            })

            return {
                ...step,
                settings: {
                    ...step.settings,
                    input: {
                        ...step.settings.input,
                        [AgentQadamProps.AGENT_TOOLS]: newTools,
                    },
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '24',
        }
    },
}

type AgentToolInput = {
    type: string
    toolName: string
    pieceMetadata?: { qadamName: string, qadamVersion: string, actionName: string, [key: string]: unknown }
    [key: string]: unknown
}

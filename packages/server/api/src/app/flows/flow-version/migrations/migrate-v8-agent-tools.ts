import {
    AgentQadamProps,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { Migration } from '.'

export const cleanUpAgentTools: Migration = {
    targetSchemaVersion: '8',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type === FlowActionType.PIECE && step.settings.qadamName === '@aiqadam/qadam-agent') {
                const rawTools = step.settings.input['agentTools']
                // `input` is `z.record(z.string(), z.unknown())` — nothing upstream guarantees
                // `agentTools` is an array. A non-array here would throw on `.map` below, which
                // `flowVersionMigrationService.migrate` rethrows and pages on-call for, 500ing every
                // read of that one flow version. Treat it as nothing to migrate instead (#1028).
                if (!isNil(rawTools) && !Array.isArray(rawTools)) {
                    system.globalLogger().warn({ flowVersionId: flowVersion.id, stepName: step.name }, '[cleanUpAgentTools] skipping step with a non-array agentTools input')
                    return step
                }
                const tools = (rawTools as { type: string, toolName: string, qadamMetadata: { qadamName: string, qadamVersion: string, actionName: string, connectionExternalId: string }, flowId: string }[] | undefined) ?? []
                const newTools = tools.map(tool => {
                    switch (tool.type) {
                        case 'PIECE': {
                            return {
                                type: tool.type,
                                toolName: tool.toolName,
                                qadamMetadata: {
                                    qadamName: tool.qadamMetadata.qadamName,
                                    qadamVersion: tool.qadamMetadata.qadamVersion,
                                    actionName: tool.qadamMetadata.actionName,
                                    predefinedInput: {
                                        auth: !isNil(tool.qadamMetadata.connectionExternalId) ? `{{connections['${tool.qadamMetadata.connectionExternalId}']}}` : undefined,
                                    },
                                },
                            }
                        }
                        case 'FLOW': {
                            return {
                                type: tool.type,
                                toolName: tool.toolName,
                                flowId: tool.flowId,
                            }
                        }
                        default: {
                            throw new Error(`Unknown tool type: ${tool.type}`)
                        }
                    }
                })

                step.settings = {
                    ...step.settings,
                    qadamVersion: '0.3.7',
                    input: {
                        ...step.settings.input,
                        [AgentQadamProps.AGENT_TOOLS]: newTools,
                    },
                }
            }
            return step
        })

        return {
            ...newVersion,
            schemaVersion: '9',
        }
    },
}
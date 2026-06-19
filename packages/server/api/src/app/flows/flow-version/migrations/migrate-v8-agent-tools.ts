import {
    AgentQadamProps,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { Migration } from '.'

export const cleanUpAgentTools: Migration = {
    targetSchemaVersion: '8',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type === FlowActionType.PIECE && step.settings.qadamName === '@aiqadam/qadam-agent') {
                const tools = (step.settings.input['agentTools'] as { type: string, toolName: string, qadamMetadata: { qadamName: string, qadamVersion: string, actionName: string, connectionExternalId: string }, flowId: string }[]) ?? []
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
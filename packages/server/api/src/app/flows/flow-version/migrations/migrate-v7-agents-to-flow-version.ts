import {
    AgentQadamProps,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
    PopulatedFlow,
} from '@aiqadam/shared'
import { databaseConnection } from '../../../database/database-connection'
import { Migration } from '.'

export const moveAgentsToFlowVerion: Migration = {
    targetSchemaVersion: '7',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const db = databaseConnection()

        const agentsAndMcpPromises = await Promise.all(
            flowStructureUtil.getAllSteps(flowVersion.trigger).map(async (step): Promise<{ agent: Record<string, unknown>, tools: { type: string, toolName: string, qadamMetadata: { qadamName: string, qadamVersion: string, actionName: string, connectionExternalId: string }, flowId: string }[] } | null> => {
                if (step.type === FlowActionType.PIECE && step.settings.qadamName === '@aiqadam/qadam-agent') {
                    const agentResults = await db.query('SELECT * FROM agent WHERE "externalId" = $1', [step.settings.input['agentId']])
                    if (isNil(agentResults) || agentResults.length === 0) {
                        return null
                    }
                    const agent = agentResults[0]
                    if (isNil(agent.mcpId)) {
                        return null
                    }

                    const dbTools = await db.query('SELECT * FROM mcp_tool WHERE "mcpId" = $1', [agent.mcpId])

                    const tools = dbTools.map((tool: {
                        type: string
                        qadamMetadata: string | Record<string, unknown>
                        mcpId: string
                        flow: string
                        flowId: string
                    }) => {
                        if (tool.type === 'PIECE') {
                            const qadamMetadata = typeof tool.qadamMetadata === 'string' ? JSON.parse(tool.qadamMetadata) : tool.qadamMetadata
                            return {
                                type: tool.type,
                                toolName: qadamMetadata.actionName,
                                qadamMetadata,
                                mcpId: tool.mcpId,
                            }
                        }
                        else {
                            if (isNil(tool.flow)) {
                                return null
                            }
                            const populatedFlow = JSON.parse(tool.flow) as PopulatedFlow
                            return {
                                type: tool.type,
                                toolName: populatedFlow.id,
                                mcpId: tool.mcpId,
                                flow: populatedFlow,
                                flowId: tool.flowId,
                            }
                        }
                    })

                    return {
                        agent,
                        tools: tools.filter((tool: unknown) => !isNil(tool)),
                    }
                }
                return null
            }),
        )

        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type === FlowActionType.PIECE && step.settings.qadamName === '@aiqadam/qadam-agent') {
                const prompt = step.settings.input['prompt']
                const agentAndTools = agentsAndMcpPromises.find((agentAndMcp) => agentAndMcp?.agent?.externalId === step.settings.input['agentId'])

                if (!agentAndTools) {
                    return {
                        ...step,
                        settings: {
                            ...step.settings,
                            qadamVersion: '0.3.0',
                        },
                    }
                }

                const { agent, tools } = agentAndTools

                step.displayName = agent?.displayName as string
                step.settings = {
                    ...step.settings,
                    qadamVersion: '0.3.0',
                    input: {
                        [AgentQadamProps.PROMPT]: `${agent?.systemPrompt}, ${prompt}`,
                        'model': 'openai-gpt-4o',
                        [AgentQadamProps.MAX_STEPS]: agent?.maxSteps,
                        [AgentQadamProps.STRUCTURED_OUTPUT]: typeof agent?.outputFields === 'string' ? JSON.parse(agent?.outputFields as string || '[]') : [],
                        [AgentQadamProps.AGENT_TOOLS]: tools                    },
                }
            }
            return step
        })

        return {
            ...newVersion,
            schemaVersion: '8',
        }
    },
}
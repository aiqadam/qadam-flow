import { AgentQadamProps, AgentQadamTool } from '../../agents'
import { ExportedUnresolvedStep } from '../../qadams/exported-snapshot'
import { FlowActionType } from '../actions/action'
import { FlowTrigger, FlowTriggerType } from '../triggers/trigger'
import { flowStructureUtil } from '../util/flow-structure-util'

export const flowQadamUtil = {
    getExactVersion(qadamVersion: string): string {
        if (qadamVersion.startsWith('^') || qadamVersion.startsWith('~')) {
            return qadamVersion.slice(1)
        }
        return qadamVersion
    },
    // The entries of an exporter's exported-unresolved list that name a qadam step of this flow. The
    // list is untrusted, so an entry marks a step only when its step name matches and its qadam is
    // the step's own or that of one of the step's agent tools (a tool's pin is listed under the
    // tool's qadam, and it is the agent step that is marked).
    getMarkableUnresolved({ trigger, steps }: { trigger: FlowTrigger, steps: ExportedUnresolvedStep[] | undefined }): ExportedUnresolvedStep[] {
        const known = new Set(flowStructureUtil.getAllSteps(trigger).flatMap((step) => {
            if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
                return []
            }
            const qadams = [step.settings.qadamName, ...toolQadamNames({ input: step.settings.input })]
            return qadams.map((qadamName) => markKey({ stepName: step.name, qadamName }))
        }))
        return (steps ?? []).filter((entry) => known.has(markKey({ stepName: entry.stepName, qadamName: entry.qadamName })))
    },
    getUsedQadams(trigger: FlowTrigger): string[] {
        return flowStructureUtil.getAllSteps(trigger)
            .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
            .map((step) => step.settings.qadamName)
    },
}

function markKey({ stepName, qadamName }: { stepName: string, qadamName: string }): string {
    return JSON.stringify([stepName, qadamName])
}

function toolQadamNames({ input }: { input: Record<string, unknown> }): string[] {
    const tools = input[AgentQadamProps.AGENT_TOOLS]
    if (!Array.isArray(tools)) {
        return []
    }
    return tools.flatMap((tool) => {
        const parsed = AgentQadamTool.safeParse(tool)
        return parsed.success ? [parsed.data.qadamMetadata.qadamName] : []
    })
}

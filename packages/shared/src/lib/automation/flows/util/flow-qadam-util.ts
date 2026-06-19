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
    getUsedQadams(trigger: FlowTrigger): string[] {
        return flowStructureUtil.getAllSteps(trigger)
            .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
            .map((step) => step.settings.qadamName)
    },
}

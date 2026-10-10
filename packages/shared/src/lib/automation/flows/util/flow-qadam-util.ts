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
    // The entries of an exporter's exported-unresolved list that name a qadam step of this flow (the
    // list is untrusted, so a name or qadam that matches no step marks nothing).
    getMarkableUnresolved({ trigger, steps }: { trigger: FlowTrigger, steps: ExportedUnresolvedStep[] | undefined }): ExportedUnresolvedStep[] {
        const qadamSteps = flowStructureUtil.getAllSteps(trigger)
            .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
        return (steps ?? []).filter((entry) => qadamSteps.some((step) => step.name === entry.stepName && step.settings.qadamName === entry.qadamName))
    },
    getUsedQadams(trigger: FlowTrigger): string[] {
        return flowStructureUtil.getAllSteps(trigger)
            .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
            .map((step) => step.settings.qadamName)
    },
}

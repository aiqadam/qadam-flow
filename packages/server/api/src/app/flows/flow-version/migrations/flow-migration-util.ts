import { FlowActionType, flowStructureUtil, FlowTriggerType, FlowVersion } from '@aiqadam/shared'

export const flowMigrationUtil = {
    pinPieceToVersion(flowVersion: FlowVersion, qadamName: string, qadamVersion: string) {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if ((step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE) && step.settings.qadamName === qadamName) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion,
                    },
                }
            }
            return step
        })
        return newVersion
    },
}
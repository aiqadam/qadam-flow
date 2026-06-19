import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    isNil,
    tryCatch,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { flowService } from '../../flow/flow.service'
import { Migration } from '.'

export const migrateV12FixPieceVersion: Migration = {
    targetSchemaVersion: '12',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        if (flowVersion.state !== FlowVersionState.LOCKED) {
            return {
                ...flowVersion,
                schemaVersion: '13',
            }
        }

        const flow = await flowService(system.globalLogger()).getOneById(flowVersion.flowId)
        if (isNil(flow)) {
            return {
                ...flowVersion,
                schemaVersion: '13',
            }
        }
        const platformId = await projectService(system.globalLogger()).getPlatformId(flow.projectId)
        const stepNameToPieceVersion: Record<string, string> = {}
        const steps = flowStructureUtil.getAllSteps(flowVersion.trigger)
        for (const step of steps) {
            if (step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE) {
                const { data: qadamMetadata } = await tryCatch(async () => qadamMetadataService(system.globalLogger()).getOrThrow({
                    platformId,
                    name: step.settings.qadamName,
                    version: step.settings.qadamVersion,
                }),
                )
                if (!isNil(qadamMetadata)) {
                    stepNameToPieceVersion[step.name] = qadamMetadata.version
                }
            }
        }
        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (stepNameToPieceVersion[step.name]) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion: stepNameToPieceVersion[step.name],
                    },
                }
            }
            return step
        })
        return {
            ...newFlowVersion,
            schemaVersion: '13',
        }
    },
}


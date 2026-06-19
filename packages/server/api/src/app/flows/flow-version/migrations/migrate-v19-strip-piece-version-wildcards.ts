import {
    FlowActionType,
    flowQadamUtil,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { flowService } from '../../flow/flow.service'
import { Migration } from '.'

export const migrateV19StripPieceVersionWildcards: Migration = {
    targetSchemaVersion: '19',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const log = system.globalLogger()
        const flow = await flowService(log).getOneById(flowVersion.flowId)
        const platformId = isNil(flow)
            ? undefined
            : await projectService(log).getPlatformId(flow.projectId)

        const stepNameToExactVersion: Record<string, string> = {}
        const steps = flowStructureUtil.getAllSteps(flowVersion.trigger)

        for (const step of steps) {
            if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
                continue
            }
            const version: string = step.settings.qadamVersion
            if (!version.startsWith('~') && !version.startsWith('^')) {
                continue
            }
            const qadamMetadata = await qadamMetadataService(log).get({
                platformId,
                name: step.settings.qadamName,
                version,
            })
            stepNameToExactVersion[step.name] = isNil(qadamMetadata)
                ? flowQadamUtil.getExactVersion(version)
                : qadamMetadata.version
        }

        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            const exactVersion = stepNameToExactVersion[step.name]
            if (isNil(exactVersion)) {
                return step
            }
            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: exactVersion,
                },
            }
        })

        return {
            ...newFlowVersion,
            schemaVersion: '20',
        }
    },
}

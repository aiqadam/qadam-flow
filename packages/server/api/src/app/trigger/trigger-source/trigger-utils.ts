import { TriggerBase } from '@aiqadam/qadams-framework'
import {
    ErrorCode,
    FlowTriggerType,
    FlowVersion,
    isNil,
    ProjectId,
    QadamFlowError,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { projectService } from '../../project/project-service'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'

export const triggerUtils = (log: FastifyBaseLogger) => ({
    async getQadamTriggerOrThrow({ flowVersion, projectId }: GetQadamTriggerOrThrowParams): Promise<TriggerBase> {

        const qadamTrigger = await this.getQadamTrigger({
            flowVersion,
            projectId,

        })
        if (isNil(qadamTrigger)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'qadam_trigger',
                    entityId: flowVersion.trigger.settings.triggerName,
                    message: `Trigger not found for qadam ${flowVersion.trigger.settings.qadamName}@${flowVersion.trigger.settings.qadamVersion}`,
                    extra: {
                        qadamName: flowVersion.trigger.settings.qadamName,
                        qadamVersion: flowVersion.trigger.settings.qadamVersion,
                        triggerName: flowVersion.trigger.settings.triggerName,
                    },
                },
            })
        }
        return qadamTrigger
    },
    async getQadamTrigger({ flowVersion, projectId }: GetQadamTriggerOrThrowParams): Promise<TriggerBase | null> {
        if (flowVersion.trigger.type !== FlowTriggerType.PIECE) {
            return null
        }
        const { qadamName, qadamVersion, triggerName } = flowVersion.trigger.settings
        if (isNil(triggerName)) {
            return null
        }
        return this.getQadamTriggerByName({
            qadamName,
            qadamVersion,
            triggerName,
            projectId,
        })
    },
    async getQadamTriggerByName({ qadamName, qadamVersion, triggerName, projectId }: GetQadamTriggerByNameParams): Promise<TriggerBase | null> {
        const platformId = await projectService(log).getPlatformId(projectId)
        const qadam = await qadamMetadataService(log).get({
            platformId,
            name: qadamName,
            version: qadamVersion,
        })
        if (isNil(qadam) || isNil(triggerName)) {
            return null
        }
        const qadamTrigger = qadam.triggers[triggerName]
        return qadamTrigger
    },
})

type GetQadamTriggerByNameParams = {
    qadamName: string
    qadamVersion: string
    triggerName: string
    projectId: ProjectId
}

type GetQadamTriggerOrThrowParams = {
    flowVersion: FlowVersion
    projectId: ProjectId
}
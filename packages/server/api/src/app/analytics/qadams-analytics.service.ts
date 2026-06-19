import { FlowActionType, FlowStatus, flowStructureUtil, FlowTriggerType, isNil, QadamAction, QadamTrigger } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from     '../core/db/repo-factory'
import { FlowEntity } from '../flows/flow/flow.entity'
import { flowVersionService } from '../flows/flow-version/flow-version.service'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { projectService } from '../project/project-service'
import { qadamMetadataService } from '../qadams/metadata/qadam-metadata-service'

const flowRepo = repoFactory(FlowEntity)

export const piecesAnalyticsService = (log: FastifyBaseLogger) => ({
    async init(): Promise<void> {
        systemJobHandlers.registerJobHandler(SystemJobName.PIECES_ANALYTICS, async () => {
            const flowIds: string[] = (await flowRepo().createQueryBuilder().select('id').where({
                status: FlowStatus.ENABLED,
            }).getRawMany()).map((flow) => flow.id)
            const activeProjects: Record<string, Set<string>> = {}
            log.info('Syncing pieces analytics')
            for (const flowId of flowIds) {
                const flow = await flowRepo().findOneBy({
                    id: flowId,
                })
                const publishedVersionId = flow?.publishedVersionId
                if (isNil(flow) || isNil(publishedVersionId)) {
                    continue
                }
                const flowVersion = await flowVersionService(log).getOne(publishedVersionId)
                if (isNil(flowVersion)) {
                    continue
                }
                const qadams = flowStructureUtil.getAllSteps(flowVersion.trigger).filter(
                    (step) =>
                        step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE,
                ).map((step) => {
                    const clonedStep = step as (QadamTrigger | QadamAction)
                    return {
                        name: clonedStep.settings.qadamName,
                        version: clonedStep.settings.qadamVersion,
                    }
                })
                const platformId = await projectService(log).getPlatformId(flow.projectId)

                for (const qadam of qadams) {
                    try {
                        const qadamMetadata = await qadamMetadataService(log).getOrThrow({
                            name: qadam.name,
                            version: qadam.version,
                            platformId,
                        })
                        const qadamId = qadamMetadata.id!
                        activeProjects[qadamId] = activeProjects[qadamId] || new Set()
                        activeProjects[qadamId].add(flow.projectId)
                    }
                    catch (e) {
                        log.error({
                            name: qadam.name,
                            version: qadam.version,
                        }, 'Qadam not found in qadams analytics service')
                    }
                }
            }
            for (const id in activeProjects) {
                await qadamMetadataService(log).updateUsage({
                    id,
                    usage: activeProjects[id].size,
                })
            }
            log.info('Synced pieces analytics finished')
        })
        await systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.PIECES_ANALYTICS,
                data: {},
                jobId: SystemJobName.PIECES_ANALYTICS,
            },
            schedule: {
                type: 'repeated',
                cron: '0 12 * * *',
            },
        })
    },
})
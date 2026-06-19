import { WebhookRenewStrategy } from '@aiqadam/qadams-framework'
import { isNil, LATEST_JOB_DATA_SCHEMA_VERSION, TriggerSourceScheduleType, TriggerStrategy, WorkerJobType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull } from 'typeorm'
import { projectService } from '../../project/project-service'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'
import { triggerSourceRepo } from '../../trigger/trigger-source/trigger-source-service'
import { jobQueue, JobType } from '../job-queue/job-queue'

export const refillRenewWebhookJobs = (log: FastifyBaseLogger) => ({
    async run(): Promise<void> {
        const triggerSources = await triggerSourceRepo().find({
            where: {
                deleted: IsNull(),
                simulate: false,
                type: TriggerStrategy.WEBHOOK,
            },
        })
        let migratedRenewWebhookJobs = 0

        const batchSize = 100
        for (let i = 0; i < triggerSources.length; i += batchSize) {
            const batch = triggerSources.slice(i, i + batchSize)
            await Promise.all(batch.map(async (triggerSource) => {
                const qadamMetadata = await qadamMetadataService(log).get({
                    name: triggerSource.qadamName,
                    version: triggerSource.qadamVersion,
                    platformId: await projectService(log).getPlatformId(triggerSource.projectId),
                })
                const pieceTrigger = qadamMetadata?.triggers?.[triggerSource.triggerName]
                if (isNil(pieceTrigger) || isNil(pieceTrigger.renewConfiguration) || pieceTrigger.renewConfiguration.strategy !== WebhookRenewStrategy.CRON) {
                    return
                }
                await jobQueue(log).add({
                    id: triggerSource.flowVersionId,
                    type: JobType.REPEATING,
                    data: {
                        projectId: triggerSource.projectId,
                        platformId: await projectService(log).getPlatformId(triggerSource.projectId),
                        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                        flowVersionId: triggerSource.flowVersionId,
                        flowId: triggerSource.flowId,
                        jobType: WorkerJobType.RENEW_WEBHOOK,
                    },
                    scheduleOptions: {
                        type: TriggerSourceScheduleType.CRON_EXPRESSION,
                        cronExpression: pieceTrigger.renewConfiguration.cronExpression,
                        timezone: 'UTC',
                    },
                })
                migratedRenewWebhookJobs++
            }))
        }

        log.info({
            migratedRenewWebhookJobs,
        }, '[renewWebhookJobsMigration] Migrated renew webhook jobs')
    },
})
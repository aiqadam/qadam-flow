import { apId, ErrorCode, FlowId, flowStructureUtil, FlowVersion, isNil, PopulatedTriggerSource, QadamFlowError, TemplateTelemetryEventType, TriggerSource } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { ArrayContains, In } from 'typeorm'
import { appConnectionsRepo } from '../../app-connection/app-connection-service/app-connection-service'
import { repoFactory } from '../../core/db/repo-factory'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { templateTelemetryService } from '../../template/template-telemetry/template-telemetry.service'
import { jobQueue } from '../../workers/job-queue/job-queue'
import { flowTriggerSideEffect } from './flow-trigger-side-effect'
import { TriggerSourceEntity } from './trigger-source-entity'
import { triggerUtils } from './trigger-utils'

export const triggerSourceRepo = repoFactory(TriggerSourceEntity)

/**
 * The delivery mode lives on the connection, so answering "is this transport available" needs the
 * connection, not the step. Only `metadata` is read — unencrypted, and scoped to this project.
 */
async function readTriggerConnectionMetadata({ flowVersion, projectId }: ReadTriggerConnectionMetadataParams): Promise<Record<string, unknown> | undefined> {
    const auth: unknown = flowVersion.trigger.settings?.input?.auth
    if (typeof auth !== 'string') {
        return undefined
    }
    const externalId = flowStructureUtil.extractConnectionIdsFromAuth(auth)[0]
    if (isNil(externalId)) {
        return undefined
    }
    const connection = await appConnectionsRepo().findOne({
        where: { projectIds: ArrayContains([projectId]), externalId },
        select: ['metadata'],
    })
    return connection?.metadata ?? undefined
}

/**
 * Imported on demand rather than at module scope. A static import pulls the host's whole graph —
 * the webhook service, the connection service, the puller registry — into every module that
 * touches trigger sources, which is enough to create an evaluation-order cycle in unrelated code.
 */
const longPollingHostLazy = (log: FastifyBaseLogger) => ({
    async assertTransportIsAvailable(params: { qadamName: string, readConnectionMetadata: () => Promise<Record<string, unknown> | undefined> }): Promise<void> {
        const { longPollingHost } = await import('../long-polling/long-polling-host')
        await longPollingHost(log).assertTransportIsAvailable(params)
    },
    requestSync(): void {
        rejectedPromiseHandler(
            import('../long-polling/long-polling-host').then(({ longPollingHost }) => longPollingHost(log).requestSync()),
            log,
        )
    },
})

export const triggerSourceService = (log: FastifyBaseLogger) => {
    return {
        async enable(params: EnableTriggerParams): Promise<TriggerSource> {
            const { flowVersion, projectId, simulate, templateId } = params
            log.info({
                flowId: flowVersion.flowId,
                flowVersionId: flowVersion.id,
                projectId,
                simulate,
            }, '[triggerSourceService#enable] Enabling trigger source')
            const qadamTrigger = await triggerUtils(log).getQadamTriggerOrThrow({ flowVersion, projectId })
            // Before the engine's ON_ENABLE hook runs: for a pull-transport trigger that hook
            // removes the webhook, so refusing afterwards would leave the flow with no delivery.
            // Read lazily and only for a qadam that has a puller: an eagerly-evaluated argument here
            // would put one `findOne` on every publish and every flow enable, product-wide, for a
            // value `assertTransportIsAvailable` discards immediately in all but one qadam.
            await longPollingHostLazy(log).assertTransportIsAvailable({
                qadamName: flowVersion.trigger.settings.qadamName,
                readConnectionMetadata: () => readTriggerConnectionMetadata({ flowVersion, projectId }),
            })
            const existingTriggerSource = await triggerSourceRepo().findOne({
                where: {
                    flowId: flowVersion.flowId,
                    projectId,
                    simulate,
                },
                withDeleted: true,
            })
            if (!isNil(existingTriggerSource)) {
                await jobQueue(log).removeRepeatingJob({ flowVersionId: existingTriggerSource.flowVersionId })
            }
            await triggerSourceRepo().softDelete({
                flowId: flowVersion.flowId,
                projectId,
                simulate,
            })
            log.info('[triggerSourceService#enable] Soft deleted trigger source')
            const triggerSourceWithouSchedule: Omit<TriggerSource, 'created' | 'updated' | 'schedule'> = {
                id: apId(),
                type: qadamTrigger.type,
                projectId,
                flowId: flowVersion.flowId,
                triggerName: qadamTrigger.name,
                flowVersionId: flowVersion.id,
                qadamName: flowVersion.trigger.settings.qadamName,
                qadamVersion: flowVersion.trigger.settings.qadamVersion,
                simulate,
            }
            const triggerSource = await triggerSourceRepo().save(triggerSourceWithouSchedule)
            const { scheduleOptions } = await flowTriggerSideEffect(log).enable({
                flowId: flowVersion.flowId,
                flowVersionId: flowVersion.id,
                projectId,
                qadamName: flowVersion.trigger.settings.qadamName,
                qadamTrigger,
                simulate,
            })

            if (templateId) {
                templateTelemetryService(log).sendEvent({
                    eventType: TemplateTelemetryEventType.ACTIVATE,
                    templateId,
                    flowId: flowVersion.flowId,
                })
            }

            log.info('[triggerSourceService#enable] Enabled flow trigger side effect')
            const saved = await triggerSourceRepo().save({
                ...triggerSource,
                schedule: scheduleOptions,
            })
            longPollingHostLazy(log).requestSync()
            return saved
        },
        async get(params: GetTriggerParams): Promise<TriggerSource | null> {
            const { projectId, id } = params
            return triggerSourceRepo().findOne({
                where: {
                    id,
                    projectId,
                },
            })
        },
        async getByFlowId(params: GetFlowIdParamsWithProjectId): Promise<TriggerSource | null> {
            const { flowId, simulate, projectId } = params
            return triggerSourceRepo().findOne({
                where: {
                    flowId,
                    simulate,
                    ...(projectId ? { projectId } : {}),
                },
            })
        },
        async getByFlowIds(params: GetByFlowIdsParams): Promise<Map<FlowId, TriggerSource>> {
            const { flowIds, projectId } = params
            if (flowIds.length === 0) {
                return new Map()
            }
            const triggerSources = await triggerSourceRepo().find({
                where: {
                    flowId: In(flowIds),
                    projectId,
                },
            })
            const result = new Map<FlowId, TriggerSource>()
            for (const ts of triggerSources) {
                result.set(ts.flowId, ts)
            }
            return result
        },
        async getByFlowIdPopulated(params: GetByFlowIdParams): Promise<PopulatedTriggerSource | null> {
            const { flowId, simulate } = params
            return triggerSourceRepo().findOne({
                where: {
                    flowId,
                    simulate,
                },
                relations: {
                    flow: true,
                },
            })
        },
        async getOrThrow({ projectId, id }: GetTriggerParams): Promise<TriggerSource> {
            const triggerSource = await triggerSourceRepo().findOne({
                where: {
                    id,
                    projectId,
                },
            })
            if (isNil(triggerSource)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'trigger',
                        entityId: id,
                    },
                })
            }
            return triggerSource
        },
        async existsByFlowId(params: ExistsByFlowIdParams): Promise<boolean> {
            const { flowId, simulate } = params
            return triggerSourceRepo().existsBy({
                flowId,
                simulate,
            })
        },
        async disable(params: DisableTriggerParams): Promise<void> {
            const { projectId, flowId, simulate, templateId } = params
            log.info({
                flowId,
                projectId,
                simulate,
            }, '[triggerSourceService#disable] Disabling trigger source')
            const triggerSource = await triggerSourceRepo().findOneBy({
                flowId,
                projectId,
                simulate,
            })
            if (isNil(triggerSource)) {
                return
            }
            const flowVersion = await flowVersionService(log).getOneOrThrow(triggerSource.flowVersionId)
            const qadamTrigger = await triggerUtils(log).getQadamTrigger({ flowVersion, projectId })
            if (!isNil(qadamTrigger)) {
                await flowTriggerSideEffect(log).disable({
                    flowId: triggerSource.flowId,
                    flowVersionId: triggerSource.flowVersionId,
                    projectId,
                    qadamName: triggerSource.qadamName,
                    qadamTrigger,
                    simulate,
                    ignoreError: params.ignoreError,
                })
                log.info('[triggerSourceService#disable] Disabled flow trigger side effect')
            }
            await triggerSourceRepo().softDelete({
                id: triggerSource.id,
                projectId,
            })
            log.info('[triggerSourceService#disable] Soft deleted trigger source')
            longPollingHostLazy(log).requestSync()
            if (templateId) {
                templateTelemetryService(log).sendEvent({
                    eventType: TemplateTelemetryEventType.DEACTIVATE,
                    templateId,
                    flowId,
                })
            }
        },
    }
}

type ReadTriggerConnectionMetadataParams = {
    flowVersion: FlowVersion
    projectId: string
}

type ExistsByFlowIdParams = {
    flowId: string
    simulate: boolean
}

type GetByFlowIdParams = {
    flowId: string
    projectId?: string
    simulate: boolean
}

type GetByFlowIdsParams = {
    flowIds: FlowId[]
    projectId: string
}

type GetFlowIdParamsWithProjectId = {
    flowId: string
    projectId: string
    simulate: boolean | undefined
}

type GetTriggerParams = {
    projectId: string
    id: string
}

type DisableTriggerParams = {
    projectId: string
    flowId: string
    simulate: boolean
    ignoreError: boolean
    templateId?: string
}

type EnableTriggerParams = {
    flowVersion: FlowVersion
    projectId: string
    simulate: boolean
    templateId?: string
}
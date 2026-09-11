import { FlowStatus, isNil, Metadata, ProjectId, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { TriggerSourceEntity } from '../trigger-source/trigger-source-entity'
import { eventPullerRegistry } from './event-puller-registry'

const transportTriggerSourceRepo = repoFactory(TriggerSourceEntity)

/**
 * Re-runs the trigger's enable hook for flows on a connection whose delivery mode just changed.
 *
 * The mode lives on the connection, but the thing that acts on it — registering or removing the
 * webhook at the third party — happens in the qadam's `onEnable`, which only runs when a flow is
 * enabled or published. Without this, switching a connection from pulling back to webhook stops the
 * poller and never registers the webhook: the flow stays "on" and silently receives nothing. The
 * other direction is loud (the third party refuses to be polled while its webhook is live, and the
 * host reports that), but this one is silent, which is the failure the status work exists to kill.
 *
 * Deliberately keyed on the *puller's verdict* rather than on a key name: core asks whether the
 * puller's answer changed between the old and new metadata, so it stays ignorant of the third
 * party, and a metadata edit that has nothing to do with delivery re-runs nothing.
 */
export const longPollingTransportChange = (log: FastifyBaseLogger) => ({
    async reEnableAffectedFlows(params: ReEnableParams): Promise<void> {
        const { qadamName, before, after, projectIds, externalId } = params
        if (!eventPullerRegistry.isRegistered(qadamName)) {
            return
        }
        const puller = await eventPullerRegistry.getOrLoad(qadamName)
        if (isNil(puller)) {
            return
        }
        const verdict = (metadata: Metadata | null | undefined): boolean =>
            tryCatchSync(() => puller.isEnabledFor({ connectionMetadata: metadata ?? undefined })).data ?? false
        if (verdict(before) === verdict(after)) {
            return
        }

        const flows = await findEnabledFlowsUsing({ projectIds, externalId })
        log.info({
            externalId,
            qadamName,
            flowIds: flows.map((flow) => flow.flowId),
        }, '[longPollingTransportChange] Delivery mode changed, re-running the trigger hooks')

        // Imported here rather than at module scope: the trigger source service reaches the whole
        // host graph, and a static edge from the connection service to it is how an unrelated unit
        // suite was broken once already on this branch.
        const { triggerSourceService } = await import('../trigger-source/trigger-source-service')
        const { flowVersionService } = await import('../../flows/flow-version/flow-version.service')
        for (const flow of flows) {
            const { error } = await tryCatch(async () => {
                const flowVersion = await flowVersionService(log).getOneOrThrow(flow.flowVersionId)
                await triggerSourceService(log).enable({ flowVersion, projectId: flow.projectId, simulate: false })
            })
            if (error !== null) {
                // One flow failing must not stop the others, and must not fail the connection edit
                // the user just made: the mode is already saved, and the next enable will retry.
                log.error({
                    err: error,
                    flowId: flow.flowId,
                }, '[longPollingTransportChange] Could not re-run the trigger hook after a delivery-mode change')
            }
        }
    },
})

async function findEnabledFlowsUsing({ projectIds, externalId }: FindFlowsParams): Promise<AffectedFlow[]> {
    const triggerSources = await transportTriggerSourceRepo().find({
        where: {
            simulate: false,
            projectId: In(projectIds),
            flow: { status: FlowStatus.ENABLED },
        },
        relations: { flow: true },
    })
    if (triggerSources.length === 0) {
        return []
    }
    // `connectionIds` is maintained on every flow-version write, so the match is an index read
    // rather than a scan through trigger settings.
    const flowVersions = await flowVersionRepo().find({
        where: { id: In(triggerSources.map((triggerSource) => triggerSource.flowVersionId)) },
        select: ['id', 'connectionIds'],
    })
    const usingConnection = new Set(flowVersions
        .filter((flowVersion) => (flowVersion.connectionIds ?? []).includes(externalId))
        .map((flowVersion) => flowVersion.id))
    return triggerSources
        .filter((triggerSource) => usingConnection.has(triggerSource.flowVersionId))
        .map((triggerSource) => ({
            flowId: triggerSource.flowId,
            flowVersionId: triggerSource.flowVersionId,
            projectId: triggerSource.projectId,
        }))
}

type AffectedFlow = {
    flowId: string
    flowVersionId: string
    projectId: ProjectId
}

type FindFlowsParams = {
    projectIds: ProjectId[]
    externalId: string
}

type ReEnableParams = FindFlowsParams & {
    qadamName: string
    before: Metadata | null | undefined
    after: Metadata | null | undefined
}

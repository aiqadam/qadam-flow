import { FlowStatus, flowStructureUtil, isNil, Metadata, ProjectId, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { FlowVersionEntity } from '../../flows/flow-version/flow-version-entity'
import { TriggerSourceEntity } from '../trigger-source/trigger-source-entity'
import { eventPullerRegistry } from './event-puller-registry'

// Local handles rather than the services' exported repos, the same way `long-polling-source` does:
// importing `flow-version.service` reaches `trigger-source-service` through its side effects in one
// hop, which re-opens through the front door the cycle the dynamic import below shuts.
const transportTriggerSourceRepo = repoFactory(TriggerSourceEntity)
const transportFlowVersionRepo = repoFactory(FlowVersionEntity)

/**
 * Ceiling on how much work one connection edit may cause. Each flow costs an engine round trip and
 * an outbound call to the third party; without a bound, alternating a connection's mode is a cheap
 * way to make the server do a lot. Overflow is logged rather than dropped silently — the next
 * enable of those flows still does the right thing.
 */
const MAX_FLOWS_PER_CHANGE = 50

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

        const found = await findEnabledFlowsTriggeredBy({ projectIds, externalId, qadamName })
        const flows = found.slice(0, MAX_FLOWS_PER_CHANGE)
        if (found.length > flows.length) {
            log.warn({
                externalId,
                found: found.length,
                reEnabled: flows.length,
            }, '[longPollingTransportChange] Too many flows on this connection to re-enable at once; the rest keep their current transport until they are next enabled')
        }
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

/**
 * Only flows whose **trigger** is this connection. Deliberately not `flowVersion.connectionIds`,
 * which unions the trigger's auth with every action step's: a flow triggered by Gmail that merely
 * *sends* a Telegram message shares the connection, and re-running its enable hook would re-seed
 * its polling cursor and silently drop every event since its last poll.
 */
async function findEnabledFlowsTriggeredBy({ projectIds, externalId, qadamName }: FindFlowsParams): Promise<AffectedFlow[]> {
    const triggerSources = await transportTriggerSourceRepo().find({
        where: {
            simulate: false,
            qadamName,
            projectId: In(projectIds),
            flow: { status: FlowStatus.ENABLED },
        },
        relations: { flow: true },
    })
    if (triggerSources.length === 0) {
        return []
    }
    const flowVersions = await transportFlowVersionRepo().find({
        where: { id: In(triggerSources.map((triggerSource) => triggerSource.flowVersionId)) },
    })
    const triggeredByConnection = new Set(flowVersions
        .filter((flowVersion) => triggerConnectionOf(flowVersion) === externalId)
        .map((flowVersion) => flowVersion.id))
    return triggerSources
        .filter((triggerSource) => triggeredByConnection.has(triggerSource.flowVersionId))
        .map((triggerSource) => ({
            flowId: triggerSource.flowId,
            flowVersionId: triggerSource.flowVersionId,
            projectId: triggerSource.projectId,
        }))
}

/** The same predicate the registry uses to decide which connection a trigger is bound to. */
function triggerConnectionOf(flowVersion: { trigger?: { settings?: { input?: Record<string, unknown> } } }): string | undefined {
    const auth: unknown = flowVersion.trigger?.settings?.input?.auth
    if (typeof auth !== 'string') {
        return undefined
    }
    return flowStructureUtil.extractConnectionIdsFromAuth(auth)[0]
}

type AffectedFlow = {
    flowId: string
    flowVersionId: string
    projectId: ProjectId
}

type FindFlowsParams = {
    projectIds: ProjectId[]
    externalId: string
    qadamName: string
}

type ReEnableParams = FindFlowsParams & {
    before: Metadata | null | undefined
    after: Metadata | null | undefined
}

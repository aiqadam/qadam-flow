import { FlowStatus, flowStructureUtil, isNil, Metadata, ProjectId, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { FlowVersionEntity, FlowVersionSchema } from '../../flows/flow-version/flow-version-entity'
import { TriggerSourceEntity } from '../trigger-source/trigger-source-entity'
import { eventPullerRegistry } from './event-puller-registry'

// Local handles rather than the services' exported repos: importing `flow-version.service` reaches
// `trigger-source-service` through its side effects in one hop, which would re-open through the
// front door the cycle the dynamic imports below shut.
const transportTriggerSourceRepo = repoFactory(TriggerSourceEntity)
const transportFlowVersionRepo = repoFactory(FlowVersionEntity)

/**
 * One fan-out per connection at a time, and a change arriving mid-flight is **dropped** — not
 * queued. Dropping is safe precisely because the fan-out re-reads live state on entry: whatever the
 * newer change wanted, the run already in flight will see when it queries.
 *
 * This replaced a cap on the *number of flows*, which was wrong in the direction that matters. In
 * pull -> webhook there is no "next enable" to recover with: the metadata already says webhook, so
 * the registry drops those flows and the qadam's `onEnable` — the only thing that re-registers the
 * webhook it deleted — never runs. Everything past the cap would have received nothing, permanently
 * and silently, which is the failure this module exists to prevent.
 *
 * Deliberately in-process rather than a `distributedLock`. Redlock here bought nothing and cost
 * three things: it *queues* (`retryCount` is derived from the timeout, so ~600 retries at 200ms)
 * rather than dropping, so alternating the mode accumulated waiters instead of shedding them; its
 * key would have to carry a tenant to avoid two tenants' identically-named connections serialising
 * against each other; and a lock that cannot be acquired rejects, which loses the fan-out through a
 * new door. Per-instance exclusion is enough because re-enabling is idempotent — N instances doing
 * it concurrently converge on the same state.
 */
const fanOutsInFlight = new Set<string>()

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

        const inFlightKey = `${projectIds.join(',')}|${externalId}`
        if (fanOutsInFlight.has(inFlightKey)) {
            log.info({ externalId, qadamName }, '[longPollingTransportChange] A re-enable for this connection is already running; it will see this change too')
            return
        }
        fanOutsInFlight.add(inFlightKey)
        try {
            await reEnableNow({ projectIds, externalId, qadamName, log })
        }
        finally {
            fanOutsInFlight.delete(inFlightKey)
        }
    },
})

async function reEnableNow({ projectIds, externalId, qadamName, log }: ReEnableNowParams): Promise<void> {
    const flows = await findEnabledFlowsTriggeredBy({ projectIds, externalId, qadamName })
    log.info({
        externalId,
        qadamName,
        flowIds: flows.map((flow) => flow.flowId),
    }, '[longPollingTransportChange] Delivery mode changed, re-running the trigger hooks')

    // Imported here rather than at module scope: the trigger source service reaches the whole host
    // graph, and a static edge from the connection service to it is how an unrelated unit suite was
    // broken once already on this branch.
    const { triggerSourceService } = await import('../trigger-source/trigger-source-service')
    const { flowVersionService } = await import('../../flows/flow-version/flow-version.service')
    for (const flow of flows) {
        const { error } = await tryCatch(async () => {
            const flowVersion = await flowVersionService(log).getOneOrThrow(flow.flowVersionId)
            await triggerSourceService(log).enable({ flowVersion, projectId: flow.projectId, simulate: false })
        })
        if (error !== null) {
            // One flow failing must not stop the others, and must not fail the connection edit the
            // user just made: the mode is already saved, and the next enable will retry.
            log.error({
                err: error,
                flowId: flow.flowId,
            }, '[longPollingTransportChange] Could not re-run the trigger hook after a delivery-mode change')
        }
    }
}

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

/**
 * Which connection a trigger is bound to. The registry decides what to poll the same way
 * (`long-polling-source.ts:toCandidate`), with two differences that do not matter here: it also
 * requires `FlowTriggerType.PIECE`, and it reads a migrated flow version rather than the raw row —
 * no migration rewrites `auth`, and a trigger of another type has no puller to change modes for.
 */
function triggerConnectionOf(flowVersion: FlowVersionSchema): string | undefined {
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

type ReEnableNowParams = FindFlowsParams & {
    log: FastifyBaseLogger
}

type ReEnableParams = FindFlowsParams & {
    before: Metadata | null | undefined
    after: Metadata | null | undefined
}

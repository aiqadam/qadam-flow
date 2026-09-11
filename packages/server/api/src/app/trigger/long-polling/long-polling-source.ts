import { ConnectionMetadata } from '@aiqadam/qadams-framework'
import { FlowStatus, flowStructureUtil, FlowTriggerType, FlowVersion, isNil, ProjectId, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { ArrayContains, In } from 'typeorm'
import { appConnectionsRepo } from '../../app-connection/app-connection-service/app-connection-service'
import { repoFactory } from '../../core/db/repo-factory'
import { flowVersionMigrationService } from '../../flows/flow-version/flow-version-migration.service'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { TriggerSourceEntity, TriggerSourceSchema } from '../trigger-source/trigger-source-entity'
import { eventPullerRegistry } from './event-puller-registry'

// Deliberately not `triggerSourceRepo` from trigger-source-service: that module imports the host,
// which imports this one, and a cycle through three modules is not worth a shared repo handle.
const longPollingTriggerSourceRepo = repoFactory(TriggerSourceEntity)

// A function, not a shared constant: returning the same arrays to every caller is one `push` away
// from one call contaminating the next.
const emptyRegistry = (): LongPollingRegistry => ({ sources: [], starved: [], ambiguous: [] })

/**
 * Resolves which trigger sources the host should be pulling for, right now.
 *
 * This is the one query in the product that deliberately spans projects: the host runs outside any
 * user request and owns every tenant's pull loops. Everything it derives from a row stays scoped to
 * that row's own `projectId`, so a source can only ever reach its own project's connection.
 */
export const longPollingSourceRegistry = (log: FastifyBaseLogger) => ({
    async list(): Promise<LongPollingRegistry> {
        // Static names, so an install with no such trigger never evaluates a community qadam just
        // to discover that it has none.
        const qadamNames = eventPullerRegistry.registeredQadamNames()
        if (qadamNames.length === 0) {
            return emptyRegistry()
        }
        const triggerSources = await longPollingTriggerSourceRepo().find({
            where: [
                // Production: only an enabled flow should be consuming a credential.
                { qadamName: In(qadamNames), simulate: false, flow: { status: FlowStatus.ENABLED } },
                // A simulation, deliberately without the status condition. Pressing "Test trigger"
                // enables one, and the flow being built is usually not published yet — requiring
                // ENABLED here would mean the host served tests for exactly the flows that do not
                // need testing. Without the host serving them a pull-mode trigger is untestable by
                // any route: Telegram allows one `getUpdates` consumer, so the qadam cannot fetch
                // its own sample while the host holds the credential.
                { qadamName: In(qadamNames), simulate: true },
            ],
            relations: {
                flow: true,
            },
        })
        if (triggerSources.length === 0) {
            return emptyRegistry()
        }
        // Only now, once a row exists, is a puller worth the cost of loading.
        await eventPullerRegistry.load()
        const flowVersions = await getFlowVersions({ triggerSources, log })
        const candidates = triggerSources
            .map((triggerSource) => toCandidate({
                triggerSource,
                flowVersion: flowVersions.get(triggerSource.flowVersionId),
                log,
            }))
            .filter((candidate) => !isNil(candidate))
        const { wanted, ambiguous } = await keepTheOnesTheirConnectionAsksFor({ candidates, log })
        // Its own field, deliberately not merged into `starved`. The host hands `starved` to
        // `longPollingServed`, which makes the webhook endpoint refuse with 409 — correct for a
        // starved flow, which really is in pull mode, and wrong for an ambiguous one, whose mode was
        // never determined. Merging them refused live webhook deliveries for flows that were working.
        return { ...pickOnePerCredential({ sources: wanted, log }), ambiguous }
    },
})

/**
 * `migrate` throws — and pages on-call — when a flow version cannot be brought up to date. Letting
 * that escape would take the whole reconciliation down for every tenant on a single bad row, so a
 * failure drops exactly one source and the rest of the host keeps running.
 */
async function getFlowVersions({ triggerSources, log }: GetFlowVersionsParams): Promise<Map<string, FlowVersion>> {
    const projectIdByFlowVersionId = new Map(triggerSources.map((triggerSource) => [triggerSource.flowVersionId, triggerSource.projectId]))
    if (projectIdByFlowVersionId.size === 0) {
        return new Map()
    }
    const flowVersions = await flowVersionRepo().find({
        where: {
            id: In(Array.from(projectIdByFlowVersionId.keys())),
        },
    })
    const migrated = await Promise.all(
        flowVersions.map(async (flowVersion) => {
            const { data, error } = await tryCatch(() => flowVersionMigrationService(log).migrate(
                flowVersion,
                projectIdByFlowVersionId.get(flowVersion.id),
            ))
            if (error !== null) {
                log.error({
                    err: error,
                    flowVersionId: flowVersion.id,
                }, '[longPollingSourceRegistry#list] Skipping a flow version that could not be migrated')
                return null
            }
            return [flowVersion.id, data] as const
        }),
    )
    return new Map(migrated.filter((entry) => !isNil(entry)))
}

function toCandidate({ triggerSource, flowVersion, log }: ToSourceParams): LongPollingSource | null {
    const puller = eventPullerRegistry.get(triggerSource.qadamName)
    if (isNil(puller) || isNil(flowVersion) || flowVersion.trigger.type !== FlowTriggerType.PIECE) {
        return null
    }
    const config = flowVersion.trigger.settings.input
    const auth: unknown = config.auth
    const externalIds = typeof auth === 'string' ? flowStructureUtil.extractConnectionIdsFromAuth(auth) : []
    const connectionExternalId = externalIds[0]
    if (isNil(connectionExternalId)) {
        log.warn({
            flowId: triggerSource.flowId,
            qadamName: triggerSource.qadamName,
        }, '[longPollingSourceRegistry#list] Trigger asks for long polling but has no connection')
        return null
    }
    return {
        key: `${triggerSource.qadamName}|${triggerSource.projectId}|${connectionExternalId}`,
        triggerSourceId: triggerSource.id,
        qadamName: triggerSource.qadamName,
        projectId: triggerSource.projectId,
        flowId: triggerSource.flowId,
        flowVersionId: triggerSource.flowVersionId,
        connectionExternalId,
        config,
        simulate: triggerSource.simulate,
        enabledAt: triggerSource.created,
    }
}

/**
 * The delivery mode is a property of the credential, not of the step — the third party allows one
 * consumer per credential, so two flows sharing a connection must not be able to disagree about it.
 * That means the connection has to be read before the puller can say whether it wants this source.
 *
 * Only `metadata` is read, which is unencrypted, so this costs one batched query and no decryption.
 * Every row is still matched on its own `projectId`.
 */
async function keepTheOnesTheirConnectionAsksFor({ candidates, log }: KeepTheOnesParams): Promise<ClassifiedCandidates> {
    if (candidates.length === 0) {
        return { wanted: [], ambiguous: [] }
    }
    const connections = await appConnectionsRepo().find({
        where: candidates.map((candidate) => ({
            projectIds: ArrayContains([candidate.projectId]),
            externalId: candidate.connectionExternalId,
        })),
        select: ['externalId', 'projectIds', 'metadata'],
    })
    // Keyed only on the projects a candidate actually asked about. Fanning out over every
    // `projectIds` entry would let a connection shared into project P overwrite P's own
    // same-`externalId` connection, and the loser would be classified from the wrong row.
    const askedAbout = new Set(candidates.map((candidate) => `${candidate.projectId}|${candidate.connectionExternalId}`))
    const metadataByKey = new Map<string, ConnectionMetadata>()
    const ambiguous = new Set<string>()
    for (const connection of connections) {
        for (const projectId of connection.projectIds) {
            const key = `${projectId}|${connection.externalId}`
            if (!askedAbout.has(key)) {
                continue
            }
            if (metadataByKey.has(key)) {
                ambiguous.add(key)
                continue
            }
            metadataByKey.set(key, connection.metadata ?? undefined)
        }
    }
    const undecidable = candidates.filter((candidate) => ambiguous.has(`${candidate.projectId}|${candidate.connectionExternalId}`))
    undecidable.forEach((candidate) => log.error({
        projectId: candidate.projectId,
        flowId: candidate.flowId,
    }, '[longPollingSourceRegistry#list] Two connections in one project share this externalId; refusing to guess which one sets the delivery mode'))
    const wanted = candidates.filter((candidate) => {
        const puller = eventPullerRegistry.get(candidate.qadamName)
        if (isNil(puller)) {
            return false
        }
        const key = `${candidate.projectId}|${candidate.connectionExternalId}`
        if (ambiguous.has(key)) {
            return false
        }
        const connectionMetadata = metadataByKey.get(key)
        // Qadam code, so it is contained like every other call into a puller.
        const { data: enabled, error } = tryCatchSync(() => puller.isEnabledFor({ connectionMetadata }))
        if (error !== null) {
            log.error({
                err: error,
                qadamName: candidate.qadamName,
            }, '[longPollingSourceRegistry#list] Puller threw while classifying a connection')
            return false
        }
        return enabled
    })
    return { wanted, ambiguous: undecidable }
}

/**
 * A bot token accepts exactly one consumer, which is why the webhook transport already behaves as
 * last-writer-wins: whichever flow was enabled most recently owns `setWebhook`. Pulling inherits
 * that constraint rather than inventing fan-out, so the most recently enabled flow wins here too.
 *
 * A simulation outranks recency. Pressing "Test trigger" is an explicit, short-lived request to
 * watch this credential, and the user is staring at a panel waiting for it; the production flow
 * resumes the moment the simulation source goes away. The webhook transport already behaves this
 * way — testing a published Telegram flow repoints `setWebhook` at the draft URL.
 *
 * This only de-duplicates flows pointing at the *same connection*. Two connections holding the same
 * third-party credential are caught later, by the lock the host takes on the puller's credential
 * key — which is why that key exists.
 */
function pickOnePerCredential({ sources, log }: PickOnePerCredentialParams): Omit<LongPollingRegistry, 'ambiguous'> {
    const byCredential = new Map<string, LongPollingSource[]>()
    for (const source of sources) {
        byCredential.set(source.key, [...byCredential.get(source.key) ?? [], source])
    }
    const grouped = Array.from(byCredential.values()).map((candidates) => {
        const [winner, ...losers] = [...candidates].sort((a, b) =>
            Number(b.simulate) - Number(a.simulate) || b.enabledAt.localeCompare(a.enabledAt))
        if (losers.length > 0) {
            log.warn({
                projectId: winner.projectId,
                servingFlowId: winner.flowId,
                starvedFlowIds: losers.map((loser) => loser.flowId),
            }, '[longPollingSourceRegistry#list] Several flows share one connection; only the most recently enabled one receives updates')
        }
        return { winner, losers }
    })
    // Returned rather than reported: this is a query, and the host owns every side effect. Writing
    // from here also dragged the store into this module's imports, which made its unit tests open
    // a real Redis socket and leak an unhandled error after the suite had reported green.
    return {
        sources: grouped.map(({ winner }) => winner),
        starved: grouped.flatMap(({ losers }) => losers),
    }
}

type GetFlowVersionsParams = {
    triggerSources: TriggerSourceSchema[]
    log: FastifyBaseLogger
}

type ToSourceParams = {
    triggerSource: TriggerSourceSchema
    flowVersion: FlowVersion | undefined
    log: FastifyBaseLogger
}

type KeepTheOnesParams = {
    candidates: LongPollingSource[]
    log: FastifyBaseLogger
}

type ClassifiedCandidates = {
    wanted: LongPollingSource[]
    /** Cannot be classified, so cannot be polled — the host reports them rather than losing them. */
    ambiguous: LongPollingSource[]
}

type PickOnePerCredentialParams = {
    sources: LongPollingSource[]
    log: FastifyBaseLogger
}

export type LongPollingRegistry = {
    sources: LongPollingSource[]
    /**
     * In pull mode, enabled, published, and guaranteed to receive nothing: another flow holds their
     * credential. Being in pull mode is what lets the host refuse their webhook too.
     */
    starved: LongPollingSource[]
    /**
     * Their connection cannot be identified unambiguously, so their mode is unknown — they are not
     * polled, and their webhook must keep working, because for all anyone here knows it is live.
     */
    ambiguous: LongPollingSource[]
}

export type LongPollingSource = {
    key: string
    /** A builder "Test trigger" source: collects sample data instead of running the live flow. */
    simulate: boolean
    triggerSourceId: string
    qadamName: string
    projectId: ProjectId
    flowId: string
    flowVersionId: string
    connectionExternalId: string
    config: unknown
    enabledAt: string
}

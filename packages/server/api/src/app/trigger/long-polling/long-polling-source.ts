import { FlowStatus, flowStructureUtil, FlowTriggerType, FlowVersion, isNil, ProjectId, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { flowVersionMigrationService } from '../../flows/flow-version/flow-version-migration.service'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { TriggerSourceEntity, TriggerSourceSchema } from '../trigger-source/trigger-source-entity'
import { eventPullerRegistry } from './event-puller-registry'

// Deliberately not `triggerSourceRepo` from trigger-source-service: that module imports the host,
// which imports this one, and a cycle through three modules is not worth a shared repo handle.
const longPollingTriggerSourceRepo = repoFactory(TriggerSourceEntity)

/**
 * Resolves which trigger sources the host should be pulling for, right now.
 *
 * This is the one query in the product that deliberately spans projects: the host runs outside any
 * user request and owns every tenant's pull loops. Everything it derives from a row stays scoped to
 * that row's own `projectId`, so a source can only ever reach its own project's connection.
 */
export const longPollingSourceRegistry = (log: FastifyBaseLogger) => ({
    async list(): Promise<LongPollingRegistry> {
        const qadamNames = eventPullerRegistry.qadamNames()
        if (qadamNames.length === 0) {
            return { sources: [], starved: [] }
        }
        const triggerSources = await longPollingTriggerSourceRepo().find({
            where: {
                simulate: false,
                qadamName: In(qadamNames),
                flow: {
                    status: FlowStatus.ENABLED,
                },
            },
            relations: {
                flow: true,
            },
        })
        const flowVersions = await getFlowVersions({ triggerSources, log })
        const sources = triggerSources
            .map((triggerSource) => toSource({
                triggerSource,
                flowVersion: flowVersions.get(triggerSource.flowVersionId),
                log,
            }))
            .filter((source) => !isNil(source))
        return pickOnePerCredential({ sources, log })
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

function toSource({ triggerSource, flowVersion, log }: ToSourceParams): LongPollingSource | null {
    const puller = eventPullerRegistry.get(triggerSource.qadamName)
    if (isNil(puller) || isNil(flowVersion) || flowVersion.trigger.type !== FlowTriggerType.PIECE) {
        return null
    }
    const config = flowVersion.trigger.settings.input
    // Qadam code, so it is contained like every other call into a puller.
    const { data: enabled, error } = tryCatchSync(() => puller.isEnabledFor({ config }))
    if (error !== null) {
        log.error({
            err: error,
            qadamName: triggerSource.qadamName,
        }, '[longPollingSourceRegistry#list] Puller threw while classifying a trigger')
        return null
    }
    if (!enabled) {
        return null
    }
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
        enabledAt: triggerSource.created,
    }
}

/**
 * A bot token accepts exactly one consumer, which is why the webhook transport already behaves as
 * last-writer-wins: whichever flow was enabled most recently owns `setWebhook`. Pulling inherits
 * that constraint rather than inventing fan-out, so the most recently enabled flow wins here too.
 *
 * This only de-duplicates flows pointing at the *same connection*. Two connections holding the same
 * third-party credential are caught later, by the lock the host takes on the puller's credential
 * key — which is why that key exists.
 */
function pickOnePerCredential({ sources, log }: PickOnePerCredentialParams): LongPollingRegistry {
    const byCredential = new Map<string, LongPollingSource[]>()
    for (const source of sources) {
        byCredential.set(source.key, [...byCredential.get(source.key) ?? [], source])
    }
    const grouped = Array.from(byCredential.values()).map((candidates) => {
        const [winner, ...losers] = [...candidates].sort((a, b) => b.enabledAt.localeCompare(a.enabledAt))
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

type PickOnePerCredentialParams = {
    sources: LongPollingSource[]
    log: FastifyBaseLogger
}

export type LongPollingRegistry = {
    sources: LongPollingSource[]
    /** Enabled, published, and guaranteed to receive nothing: another flow holds their credential. */
    starved: LongPollingSource[]
}

export type LongPollingSource = {
    key: string
    triggerSourceId: string
    qadamName: string
    projectId: ProjectId
    flowId: string
    flowVersionId: string
    connectionExternalId: string
    config: unknown
    enabledAt: string
}

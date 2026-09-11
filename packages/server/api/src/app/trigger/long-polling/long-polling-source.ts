import { FlowStatus, flowStructureUtil, FlowTriggerType, FlowVersion, isNil, ProjectId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { flowVersionMigrationService } from '../../flows/flow-version/flow-version-migration.service'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { TriggerSourceSchema } from '../trigger-source/trigger-source-entity'
import { triggerSourceRepo } from '../trigger-source/trigger-source-service'
import { eventPullerRegistry } from './event-puller-registry'

/**
 * Resolves which credentials the host should be pulling for, right now.
 *
 * This is the one query in the product that deliberately spans projects: the host runs outside any
 * user request and owns every tenant's pull loops. Everything it derives from a row stays scoped to
 * that row's own `projectId`, so a source can only ever reach its own project's connection.
 */
export const longPollingSourceRegistry = (log: FastifyBaseLogger) => ({
    async list(): Promise<LongPollingSource[]> {
        const qadamNames = eventPullerRegistry.qadamNames()
        if (qadamNames.length === 0) {
            return []
        }
        const triggerSources = await triggerSourceRepo().find({
            where: {
                simulate: false,
                qadamName: In(qadamNames),
            },
            relations: {
                flow: true,
            },
        })
        const enabled = triggerSources.filter((triggerSource) => triggerSource.flow.status === FlowStatus.ENABLED)
        const flowVersions = await getFlowVersions({ triggerSources: enabled, log })
        const sources = enabled
            .map((triggerSource) => toSource({
                triggerSource,
                flowVersion: flowVersions.get(triggerSource.flowVersionId),
                log,
            }))
            .filter((source) => !isNil(source))
        return pickOnePerCredential({ sources, log })
    },
})

async function getFlowVersions({ triggerSources, log }: GetFlowVersionsParams): Promise<Map<string, FlowVersion>> {
    const ids = triggerSources.map((triggerSource) => triggerSource.flowVersionId)
    if (ids.length === 0) {
        return new Map()
    }
    const flowVersions = await flowVersionRepo().find({
        where: {
            id: In(ids),
        },
    })
    const migrated = await Promise.all(
        flowVersions.map(async (flowVersion) => {
            const projectId = triggerSources.find((triggerSource) => triggerSource.flowVersionId === flowVersion.id)?.projectId
            return [flowVersion.id, await flowVersionMigrationService(log).migrate(flowVersion, projectId)] as const
        }),
    )
    return new Map(migrated)
}

function toSource({ triggerSource, flowVersion, log }: ToSourceParams): LongPollingSource | null {
    const puller = eventPullerRegistry.get(triggerSource.qadamName)
    if (isNil(puller) || isNil(flowVersion) || flowVersion.trigger.type !== FlowTriggerType.PIECE) {
        return null
    }
    const config = flowVersion.trigger.settings.input
    if (!puller.isEnabledFor({ config })) {
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
 */
function pickOnePerCredential({ sources, log }: PickOnePerCredentialParams): LongPollingSource[] {
    const byCredential = new Map<string, LongPollingSource[]>()
    for (const source of sources) {
        byCredential.set(source.key, [...byCredential.get(source.key) ?? [], source])
    }
    return Array.from(byCredential.values()).map((candidates) => {
        const [winner, ...losers] = [...candidates].sort((a, b) => b.enabledAt.localeCompare(a.enabledAt))
        if (losers.length > 0) {
            log.warn({
                projectId: winner.projectId,
                servingFlowId: winner.flowId,
                starvedFlowIds: losers.map((loser) => loser.flowId),
            }, '[longPollingSourceRegistry#list] Several flows share one credential; only the most recently enabled one receives updates')
        }
        return winner
    })
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

export type LongPollingSource = {
    key: string
    qadamName: string
    projectId: ProjectId
    flowId: string
    flowVersionId: string
    connectionExternalId: string
    config: unknown
    enabledAt: string
}

import { FlowId, isNil, LongPollingState, LongPollingStatus, ProjectId } from '@aiqadam/shared'
import { distributedStore } from '../../database/redis-connections'

/**
 * Per-flow status for the long-polling host, in Redis rather than in the host's own memory because
 * the instance that answers a user's request is rarely the one holding that credential's lock.
 *
 * Deliberately its own module, importing nothing but the store: the flow service reads this on the
 * hot path for `GET /v1/flows/:id`, and a static import of the host would drag the webhook service,
 * the connection service and the puller registry along with it.
 *
 * Entries expire. A host that dies without cleaning up stops refreshing, and the status disappears
 * rather than leaving a stale "polling" claim to be read as proof that anything is running.
 */
const TTL_SECONDS = 5 * 60

export const longPollingStatus = {
    async report(params: ReportParams): Promise<void> {
        const { projectId, flowId, status, reason, since } = params
        const state: LongPollingState = {
            status,
            ...(isNil(reason) ? {} : { reason }),
            since,
        }
        await distributedStore.put(statusKey({ projectId, flowId }), state, TTL_SECONDS)
    },
    async get(params: StatusKeyParams): Promise<LongPollingState | null> {
        return distributedStore.get<LongPollingState>(statusKey(params))
    },
    async clear(params: StatusKeyParams): Promise<void> {
        await distributedStore.delete(statusKey(params))
    },
}

function statusKey({ projectId, flowId }: StatusKeyParams): string {
    return `long-polling:status:${projectId}:${flowId}`
}

type StatusKeyParams = {
    projectId: ProjectId
    flowId: FlowId
}

type ReportParams = StatusKeyParams & {
    status: LongPollingStatus
    reason?: string
    since: string
}

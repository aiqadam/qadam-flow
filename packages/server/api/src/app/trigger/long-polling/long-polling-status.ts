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
/**
 * Part of a reason is written by the third party and part by a qadam author, and all of it is
 * stored and rendered. Capped here rather than at each call site so the bound holds for any writer.
 */
const MAX_REASON_LENGTH = 300
/** Headroom for the window that runs after a sleep, before anything reports again. */
const WINDOW_GRACE_SECONDS = 120

export const longPollingStatus = {
    async report(params: ReportParams): Promise<void> {
        const { projectId, flowId, status, reason, since, ttlSeconds } = params
        const state: LongPollingState = {
            status,
            ...(isNil(reason) ? {} : { reason: reason.slice(0, MAX_REASON_LENGTH) }),
            since,
        }
        // The floor is the default; a caller announcing a longer wait than that has to outlive it,
        // and the extra window covers the pull that follows the sleep before the next report.
        const ttl = Math.max(TTL_SECONDS, (ttlSeconds ?? 0) + WINDOW_GRACE_SECONDS)
        await distributedStore.put(statusKey({ projectId, flowId }), state, ttl)
    },
    /**
     * For a reporter that does not hold the credential lock. Yields to any entry already there, so
     * it can surface a failure every instance is hitting without contradicting the one instance
     * that is actually polling.
     */
    async reportIfAbsent(params: ReportParams): Promise<void> {
        const { projectId, flowId, status, reason, since, ttlSeconds } = params
        const state: LongPollingState = {
            status,
            ...(isNil(reason) ? {} : { reason: reason.slice(0, MAX_REASON_LENGTH) }),
            since,
        }
        await distributedStore.putIfAbsent(
            statusKey({ projectId, flowId }),
            state,
            Math.max(TTL_SECONDS, (ttlSeconds ?? 0) + WINDOW_GRACE_SECONDS),
        )
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
    /** How long the condition being reported is expected to last, when the caller knows. */
    ttlSeconds?: number
}

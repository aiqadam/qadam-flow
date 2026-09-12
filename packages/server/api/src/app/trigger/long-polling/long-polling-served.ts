import { FlowId } from '@aiqadam/shared'

/**
 * Which flows are served by pulling rather than by being called.
 *
 * In pull mode the qadam has called the third party's equivalent of `deleteWebhook`, so the third
 * party sends nothing to the webhook URL — by construction. Anything arriving there is therefore
 * not from the third party: a forgery by whoever learned the flow id, or a stray test. The webhook
 * endpoint is `securityAccess.public()` and the flow id is its only secret, so refusing is both
 * free and the only correct answer.
 *
 * In memory and not in Redis on purpose: the webhook endpoint is the hot path for the whole
 * product, and the registry query already computes this set cluster-wide on every instance once a
 * minute. A `Set` lookup costs nothing; a Redis round trip per inbound webhook would not.
 *
 * The set is empty when the host is switched off, which is the right answer then — nothing is
 * polling, so pushed deliveries are the only delivery.
 */
const pullServedFlowIds = new Set<FlowId>()

export const longPollingServed = {
    replaceAll(flowIds: FlowId[]): void {
        pullServedFlowIds.clear()
        flowIds.forEach((flowId) => pullServedFlowIds.add(flowId))
    },
    isServedByPulling(flowId: FlowId): boolean {
        return pullServedFlowIds.has(flowId)
    },
    clear(): void {
        pullServedFlowIds.clear()
    },
}

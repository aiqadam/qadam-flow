import { PopulatedRecord, TableAutomationTrigger, TableWebhookEventType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import pLimit from 'p-limit'
import { tableService } from '../table/table.service'
import { recordService } from './record.service'

export const recordSideEffects = (_log: FastifyBaseLogger) => ({
    async handleRecordsEvent(
        params: BulkSideEffectParams,
        eventKey: keyof typeof EVENT_TYPE_MAP,
    ) {
        const { projectId, tableId, records, logger, authorization } = params
        const { eventType } = EVENT_TYPE_MAP[eventKey]

        if (records.length === 0) {
            return
        }

        // Looked up once for the batch rather than once per record. The zero-webhook
        // case is the common one and it now costs a single query instead of N.
        const webhooks = await tableService.getWebhooks({ projectId, id: tableId, events: [eventType] })
        if (webhooks.length === 0) {
            return
        }

        // One flow run per row is the contract of the ON_NEW_RECORD / ON_UPDATE_RECORD
        // triggers, so the fan-out cannot be collapsed — but it can be paced. A 600-row
        // batch previously issued 600 dispatches at once, each with its own Redis read,
        // payload offload and queue add.
        const limit = pLimit(WEBHOOK_DISPATCH_CONCURRENCY)
        const dispatches = await Promise.allSettled(records.map((record) => limit(() =>
            recordService.triggerWebhooks({
                projectId,
                tableId,
                eventType,
                data: { record },
                logger,
                authorization,
                webhooks,
            }),
        )))

        // allSettled, not all: this runs after the response has already been sent, so a
        // single rejection used to abandon every dispatch still queued behind it.
        const failures = dispatches.filter((dispatch) => dispatch.status === 'rejected')
        if (failures.length > 0) {
            logger.error({ projectId, tableId, eventType, failed: failures.length, total: records.length }, '[recordSideEffects] some webhook dispatches failed')
        }
    },
})

const WEBHOOK_DISPATCH_CONCURRENCY = 10

const EVENT_TYPE_MAP: Record<
'created' | 'updated' | 'deleted',
EventTypeWithAutomation
> = {
    created: {
        eventType: TableWebhookEventType.RECORD_CREATED,
        automationTrigger: TableAutomationTrigger.ON_NEW_RECORD,
    },
    updated: {
        eventType: TableWebhookEventType.RECORD_UPDATED,
        automationTrigger: TableAutomationTrigger.ON_UPDATE_RECORD,
    },
    deleted: {
        eventType: TableWebhookEventType.RECORD_DELETED,
    },
}

type BulkSideEffectParams = {
    projectId: string
    tableId: string
    records: PopulatedRecord[]
    logger: FastifyBaseLogger
    authorization: string
    agentUpdate?: boolean
}

type EventTypeWithAutomation = {
    eventType: TableWebhookEventType
    automationTrigger?: TableAutomationTrigger
}

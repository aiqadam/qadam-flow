import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../core/common'

export enum TriggerStrategy {
    POLLING = 'POLLING',
    WEBHOOK = 'WEBHOOK',
    APP_WEBHOOK = 'APP_WEBHOOK',
    MANUAL = 'MANUAL',
}

export enum WebhookHandshakeStrategy {
    NONE = 'NONE',
    HEADER_PRESENT = 'HEADER_PRESENT',
    QUERY_PRESENT = 'QUERY_PRESENT',
    BODY_PARAM_PRESENT = 'BODY_PARAM_PRESENT',
}

export enum TriggerSourceScheduleType {
    CRON_EXPRESSION = 'CRON_EXPRESSION',
}

export const WebhookHandshakeConfiguration = z.object({
    strategy: z.nativeEnum(WebhookHandshakeStrategy),
    paramName: z.string().optional(),
})
export type WebhookHandshakeConfiguration = z.infer<typeof WebhookHandshakeConfiguration>

export const ScheduleOptions = z.object({
    type: z.nativeEnum(TriggerSourceScheduleType),
    cronExpression: z.string(),
    timezone: z.string(),
})
export type ScheduleOptions = z.infer<typeof ScheduleOptions>

export const TriggerSource = z.object({
    ...BaseModelSchema,
    type: z.nativeEnum(TriggerStrategy),
    projectId: z.string(),
    flowId: z.string(),
    triggerName: z.string(),
    schedule: Nullable(ScheduleOptions),
    flowVersionId: z.string(),
    qadamName: z.string(),
    qadamVersion: z.string(),
    deleted: Nullable(z.string()),
    simulate: z.boolean(),
})

export type TriggerSource = z.infer<typeof TriggerSource>

/**
 * What the long-polling host is currently doing for a trigger, for instances where the qadam pulls
 * instead of being called. Reported per flow so a silent bot has somewhere to explain itself:
 * without it the first `409` is "the bot stopped working and nobody knows why".
 */
export enum LongPollingStatus {
    /** A window is open, or about to be. */
    POLLING = 'POLLING',
    /** The last window failed in a way that may pass; retrying with backoff. */
    BACKING_OFF = 'BACKING_OFF',
    /** Stopped and not retrying. Disabling and re-enabling the flow is what clears it. */
    STOPPED = 'STOPPED',
}

export const LongPollingState = z.object({
    status: z.enum(LongPollingStatus),
    /** Present for BACKING_OFF and STOPPED; safe to show a user, and never carries a credential. */
    reason: z.string().optional(),
    since: z.string(),
})

export type LongPollingState = z.infer<typeof LongPollingState>

import { z } from 'zod'
import { BaseModelSchema } from '../../core/common'
import { ApId } from '../../core/common/id-generator'

export enum AlertChannel {
    EMAIL = 'EMAIL',
}

export const Alert = z.object({
    ...BaseModelSchema,
    projectId: ApId,
    channel: z.nativeEnum(AlertChannel),
    receiver: z.string(),
})

export type Alert = z.infer<typeof Alert>

export const ListAlertsParams = z.object({
    projectId: ApId,
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
})

export type ListAlertsParams = z.infer<typeof ListAlertsParams>

export const CreateAlertParams = z.object({
    projectId: ApId,
    channel: z.nativeEnum(AlertChannel),
    receiver: z.string().email(),
})

export type CreateAlertParams = z.infer<typeof CreateAlertParams>

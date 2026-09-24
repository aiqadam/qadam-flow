import { z } from 'zod'
import { RespondResponse } from '../execution/flow-execution'

export const WaitpointVersion = z.enum(['V0', 'V1'])
export type WaitpointVersion = z.infer<typeof WaitpointVersion>

export const JOIN_WAITPOINT_MAX_SLOTS = 500
export const JOIN_SLOT_MAX_DATA_BYTES = 64 * 1024

export const JoinFailurePolicy = z.enum(['ALL_SETTLED', 'FAIL_FAST', 'QUORUM'])
export type JoinFailurePolicy = z.infer<typeof JoinFailurePolicy>

// A join waitpoint (#374) is one WEBHOOK waitpoint that N queue-mode children answer, each through
// its own slot. It resumes its run once, when the failure policy decides — never per answer.
export const JoinWaitpointConfig = z.object({
    slots: z.number().int().min(1).max(JOIN_WAITPOINT_MAX_SLOTS),
    failurePolicy: JoinFailurePolicy,
    quorum: z.number().int().min(1).max(JOIN_WAITPOINT_MAX_SLOTS).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
})
export type JoinWaitpointConfig = z.infer<typeof JoinWaitpointConfig>

// `pending`: no answer yet when the failure policy decided; `timeout`: none before `timeoutSeconds`.
export const JoinSlotStatus = z.enum(['success', 'error', 'timeout', 'pending'])
export type JoinSlotStatus = z.infer<typeof JoinSlotStatus>

export const JoinSlotResult = z.object({
    status: JoinSlotStatus,
    data: z.unknown(),
})
export type JoinSlotResult = z.infer<typeof JoinSlotResult>

export const JoinResult = z.object({
    results: z.array(JoinSlotResult),
    succeeded: z.number(),
    failed: z.number(),
    timedOut: z.number(),
})
export type JoinResult = z.infer<typeof JoinResult>

export const CreateWaitpointRequest = z.object({
    flowRunId: z.string(),
    projectId: z.string(),
    stepName: z.string(),
    type: z.enum(['DELAY', 'WEBHOOK']),
    version: WaitpointVersion,
    resumeDateTime: z.string().optional(),
    responseToSend: RespondResponse.optional(),
    workerHandlerId: z.string().optional(),
    httpRequestId: z.string().optional(),
    // True only for a waitpoint that will exclusively be resumed by a POST
    // from this same server instance (e.g. callFlow's queue-mode wait-for-
    // response, resumed by the child flow's own Return Response step) — not
    // for one a human or external service resumes (e.g. an Approval link
    // clicked in an email, or a third-party webhook). Controls whether the
    // resume URL is built from the internal service address or the public
    // one; see waitpoint-controller.ts.
    internal: z.boolean().optional(),
    join: JoinWaitpointConfig.optional(),
})
export type CreateWaitpointRequest = z.infer<typeof CreateWaitpointRequest>

export const CreateWaitpointResponse = z.object({
    id: z.string(),
    resumeUrl: z.string(),
    // One URL per join slot, in slot order; absent for an ordinary waitpoint. Each carries its own
    // secret, so a child holding one can answer only its own slot.
    slotResumeUrls: z.array(z.string()).optional(),
    // Slot indexes that already have a child run or an answer, for a step that is run again.
    dispatchedSlots: z.array(z.number()).optional(),
})
export type CreateWaitpointResponse = z.infer<typeof CreateWaitpointResponse>

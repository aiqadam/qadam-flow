import { z } from 'zod'
import { RespondResponse } from '../execution/flow-execution'

export const WaitpointVersion = z.enum(['V0', 'V1'])
export type WaitpointVersion = z.infer<typeof WaitpointVersion>

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
})
export type CreateWaitpointRequest = z.infer<typeof CreateWaitpointRequest>

export const CreateWaitpointResponse = z.object({
    id: z.string(),
    resumeUrl: z.string(),
})
export type CreateWaitpointResponse = z.infer<typeof CreateWaitpointResponse>

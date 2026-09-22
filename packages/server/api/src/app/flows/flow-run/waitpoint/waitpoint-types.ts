import { ApId, FlowRunStatus, PauseType, RespondResponse, WaitpointVersion } from '@aiqadam/shared'

enum WaitpointStatus {
    PENDING = 'PENDING',
    COMPLETED = 'COMPLETED',
}

enum WaitpointVersionEnum {
    V0 = 'V0',
    V1 = 'V1',
}

type WaitpointResumePayload = {
    body?: unknown
    headers?: Record<string, string>
    queryParams?: Record<string, string>
} | null

type Waitpoint = {
    id: ApId
    created: string
    updated: string
    flowRunId: ApId
    projectId: ApId
    type: `${PauseType}`
    version: WaitpointVersion
    status: WaitpointStatus
    stepName: string
    resumeDateTime: string | null
    responseToSend: RespondResponse | null
    workerHandlerId: string | null
    httpRequestId: string | null
    resumePayload: WaitpointResumePayload | null
}

type CreateForPauseParams = {
    flowRunId: ApId
    projectId: ApId
    // The EnginePrincipal's own id (the BullMQ job id, which for an EXECUTE_FLOW job equals its
    // top-level flow run's id — see access-token-manager.ts/job-broker.ts). Used to bind the
    // request to the caller's own run instead of trusting flowRunId/projectId from the body alone.
    callerRunId: ApId
    stepName: string
    type: `${PauseType}`
    version: WaitpointVersion
    resumeDateTime?: string
    responseToSend?: RespondResponse
    workerHandlerId?: string
    httpRequestId?: string
}

type CreateForPauseResult = {
    inserted: boolean
    waitpoint: Waitpoint
}

type CompleteParams = {
    flowRunId: ApId
    projectId: ApId
    waitpointId: ApId
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
}

type CompleteResult = {
    completedExisting: boolean
    waitpoint: Waitpoint | null
}

type HandleResumeSignalParams = {
    flowRunId: ApId
    waitpointId: ApId
    flowRunStatus: FlowRunStatus
    projectId: ApId
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
    onReady: (waitpoint: Waitpoint) => Promise<void>
}

type FindPendingByVersionParams = {
    flowRunId: ApId
    projectId: ApId
    version: WaitpointVersion
}

type GetByFlowRunIdParams = {
    flowRunId: ApId
    projectId: ApId
}

type DeleteByFlowRunIdParams = {
    flowRunId: ApId
    projectId: ApId
}

type HasAnyWaitpointParams = {
    flowRunId: ApId
    projectId: ApId
}

export { WaitpointStatus, WaitpointVersionEnum }
export type { Waitpoint, WaitpointResumePayload, CreateForPauseParams, CreateForPauseResult, CompleteParams, CompleteResult, FindPendingByVersionParams, GetByFlowRunIdParams, DeleteByFlowRunIdParams, HandleResumeSignalParams, HasAnyWaitpointParams }

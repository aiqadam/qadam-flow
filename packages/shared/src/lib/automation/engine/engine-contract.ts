import { EngineOperation, EngineOperationType, EngineResponse, EngineStderr, EngineStdout } from './engine-operation'
import { ResolveInlineFlowRequest, ResolveInlineFlowResult, SendFlowResponseRequest, UpdateRunProgressRequest, UpdateStepProgressRequest, UploadRunLogsRequest } from './requests'

export type EngineContract = {
    executeOperation(input: { operationType: EngineOperationType, operation: EngineOperation }): Promise<EngineResponse<unknown>>
}

export type WorkerContract = {
    updateRunProgress(input: UpdateRunProgressRequest): Promise<void>
    uploadRunLog(input: UploadRunLogsRequest): Promise<void>
    sendFlowResponse(input: SendFlowResponseRequest): Promise<void>
    updateStepProgress(input: UpdateStepProgressRequest): Promise<void>
    // Resolves + project-scopes + piece-provisions + depth-guards a `callFlow` inline
    // target and creates its child FlowRun row, all from the worker's own trusted job
    // context (never from client/engine-supplied identity) — see .claude/rules/data-isolation.md.
    resolveInlineFlow(input: ResolveInlineFlowRequest): Promise<ResolveInlineFlowResult>
}

export type WorkerNotifyContract = {
    stdout(input: EngineStdout): void
    stderr(input: EngineStderr): void
}

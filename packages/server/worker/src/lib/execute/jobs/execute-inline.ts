import {
    BeginExecuteFlowOperation,
    EngineOperationType,
    EngineResponseStatus,
    ErrorCode,
    ExecuteFlowJobData,
    ExecutionType,
    FlowRunStatus,
    FlowVersion,
    isNil,
    QadamFlowError,
    ResumeExecuteFlowOperation,
    tryCatch,
    WorkerJobType,
} from '@aiqadam/shared'
import { flowCache } from '../../cache/flow/flow-cache'
import { workerSettings } from '../../config/worker-settings'
import { FireAndForgetJobResult, JobContext, JobHandler, JobResultKind } from '../types'
import { provisionFlowPieces } from '../utils/flow-helpers'

export const executeInlineFlowJob: JobHandler<ExecuteFlowJobData, FireAndForgetJobResult> = {
    jobType: WorkerJobType.EXECUTE_INLINE,
    async execute(ctx: JobContext, data: ExecuteFlowJobData): Promise<FireAndForgetJobResult> {
        const timeoutInSeconds = workerSettings.getSettings().FLOW_TIMEOUT_SECONDS

        const flowVersion = await flowCache(ctx.log, ctx.apiClient).getVersion({ flowVersionId: data.flowVersionId })
        if (isNil(flowVersion)) {
            ctx.log.info({ flowVersionId: data.flowVersionId }, 'Flow version not found for inline execution, skipping')
            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.INTERNAL_ERROR }
        }

        const { data: provisioned, error: provisionError } = await tryCatch(() => provisionFlowPieces({ flowVersion, platformId: data.platformId, flowId: data.flowId, projectId: data.projectId, log: ctx.log, apiClient: ctx.apiClient }))
        if (provisionError) {
            throw provisionError
        }
        if (!provisioned) {
            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.INTERNAL_ERROR }
        }

        const sandbox = ctx.sandboxManager.acquire({ log: ctx.log, apiClient: ctx.apiClient })
        try {
            await sandbox.start({
                flowVersionId: flowVersion.id,
                platformId: data.platformId,
                mounts: [],
            })

            const operation = buildFlowOperation(ctx, data, flowVersion, timeoutInSeconds)
            const result = await sandbox.execute(
                EngineOperationType.EXECUTE_FLOW,
                operation,
                { timeoutInSeconds },
            )

            // Inline execution skips log upload — state lives only in memory ExecutionState
            const httpRequestId = data.httpRequestId ?? ''
            if (httpRequestId) {
                await ctx.apiClient.sendFlowResponse({
                    workerHandlerId: data.workerHandlerId,
                    httpRequestId,
                    runResponse: {
                        status: result.status === EngineResponseStatus.OK ? 200 : 500,
                        body: { status: result.status, data: undefined },
                        headers: {},
                    },
                })
            }

            // Update flow run status so runs-metadata queue can process completion
            await reportFlowStatus(ctx, data, engineStatusToFlowRunStatus(result.status))

            return { kind: JobResultKind.FIRE_AND_FORGET, status: result.status === EngineResponseStatus.OK ? EngineResponseStatus.OK : result.status, logs: result.logs }
        }
        catch (e) {
            await ctx.sandboxManager.invalidate(ctx.log)
            if (e instanceof QadamFlowError) {
                if (e.error.code === ErrorCode.SANDBOX_EXECUTION_TIMEOUT) {
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.TIMEOUT }
                }
                if (e.error.code === ErrorCode.SANDBOX_MEMORY_ISSUE) {
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.MEMORY_ISSUE }
                }
                if (e.error.code === ErrorCode.SANDBOX_LOG_SIZE_EXCEEDED) {
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.LOG_SIZE_EXCEEDED }
                }
            }
            throw e
        }
        finally {
            await ctx.sandboxManager.release(ctx.log)
        }
    },
}

function buildFlowOperation(
    ctx: JobContext,
    data: ExecuteFlowJobData,
    flowVersion: FlowVersion,
    timeoutInSeconds: number,
): BeginExecuteFlowOperation | ResumeExecuteFlowOperation {
    const base = {
        flowVersion,
        flowRunId: data.runId,
        projectId: data.projectId,
        workerHandlerId: data.workerHandlerId ?? null,
        runEnvironment: data.environment,
        httpRequestId: data.httpRequestId ?? null,
        streamStepProgress: data.streamStepProgress,
        stepNameToTest: data.stepNameToTest ?? null,
        logsFileId: undefined, // No logs file for inline — state lives only in memory
        timeoutInSeconds,
        platformId: data.platformId,
        engineToken: ctx.engineToken,
        internalApiUrl: ctx.internalApiUrl,
        publicApiUrl: ctx.publicApiUrl,
        inlineDepth: data.inlineDepth,
    }

    return {
        ...base,
        executionType: ExecutionType.BEGIN,
        triggerPayload: data.payload,
        executeTrigger: true,
    }
}

async function reportFlowStatus(
    ctx: JobContext,
    data: ExecuteFlowJobData,
    status: FlowRunStatus,
): Promise<void> {
    await ctx.apiClient.uploadRunLog({
        runId: data.runId,
        status,
        projectId: data.projectId,
        streamStepProgress: data.streamStepProgress,
        finishTime: new Date().toISOString(),
        logsFileId: undefined, // No logs for inline
    })
}

function engineStatusToFlowRunStatus(status: EngineResponseStatus): FlowRunStatus {
    switch (status) {
        case EngineResponseStatus.OK:
            return FlowRunStatus.SUCCEEDED
        case EngineResponseStatus.TIMEOUT:
            return FlowRunStatus.TIMEOUT
        case EngineResponseStatus.MEMORY_ISSUE:
            return FlowRunStatus.MEMORY_LIMIT_EXCEEDED
        case EngineResponseStatus.LOG_SIZE_EXCEEDED:
            return FlowRunStatus.LOG_SIZE_EXCEEDED
        default:
            return FlowRunStatus.INTERNAL_ERROR
    }
}

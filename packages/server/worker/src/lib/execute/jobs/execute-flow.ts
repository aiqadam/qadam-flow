import { inspect } from 'node:util'
import { onCallService } from '@aiqadam/server-utils'
import {
    BeginExecuteFlowOperation,
    EngineOperationType,
    EngineResponseStatus,
    ErrorCode,
    ExecuteFlowJobData,
    ExecutionType,
    FlowRunStatus,
    FlowVersion,
    isFlowRunStateTerminal,
    isNil,
    QadamFlowError,
    ResumeExecuteFlowOperation,
    RunInternalError,
    RunInternalErrorSource,
    tryCatch,
    WorkerJobType,
} from '@aiqadam/shared'
import { flowCache } from '../../cache/flow/flow-cache'
import { system, WorkerSystemProp } from '../../config/configs'
import { workerSettings } from '../../config/worker-settings'
import { FireAndForgetJobResult, JobContext, JobHandler, JobResultKind } from '../types'
import { provisionFlowPieces } from '../utils/flow-helpers'

export const executeFlowJob: JobHandler<ExecuteFlowJobData, FireAndForgetJobResult> = {
    jobType: WorkerJobType.EXECUTE_FLOW,
    async execute(ctx: JobContext, data: ExecuteFlowJobData): Promise<FireAndForgetJobResult> {
        // Checked before any other work, so a run that already missed its caller's deadline never
        // reaches the sandbox at all — only a run that has not yet started is affected; one already
        // executing keeps going exactly as before (#510). `syncDeadline` is only ever set on a sync
        // webhook's initial BEGIN dispatch (webhook.service.ts#handleSync) — that includes
        // `/:flowId/draft/sync` and MCP's `returnsResponse` path, both of which also go through
        // `handleSync` — so every OTHER dispatch path (retry, async webhook, manual trigger) is
        // untouched by this check.
        //
        // Gated to the first delivery only (`ctx.attemptsStarted === 0`): a mid-execution throw or a
        // stalled-job re-delivery both come back through this same handler with the *original*
        // `syncDeadline` still in the job data, long since expired. Without this gate a re-delivery of
        // a run that is genuinely still executing (or already reported its own terminal status) would
        // be wrongly marked FAILED here, overwriting whatever real outcome it already recorded — the
        // deadline is a caller-visible promise about the FIRST attempt to start, not about every retry
        // BullMQ makes on the worker's own behalf.
        //
        // A plain wall-clock comparison assumes the dispatching API server and this worker have
        // synchronized clocks (NTP) — a worker running meaningfully behind could let a truly-expired
        // run through, and one running ahead could reject one that was still in its caller's budget.
        if (ctx.attemptsStarted === 0 && !isNil(data.syncDeadline) && Date.now() > new Date(data.syncDeadline).getTime()) {
            ctx.log.warn({ runId: data.runId, syncDeadline: data.syncDeadline }, 'Sync webhook run exceeded its dispatch deadline before starting; failing explicitly instead of executing late')
            await reportFlowStatus({
                ctx,
                data,
                status: FlowRunStatus.FAILED,
                internalError: {
                    source: RunInternalErrorSource.WORKER,
                    message: `Dispatch deadline exceeded before execution could start (syncDeadline: ${data.syncDeadline})`,
                    occurredAt: new Date().toISOString(),
                },
                // Without this, the internalError above is built but never persisted:
                // worker-rpc-service.ts only writes internalError inside its
                // `if (!isNil(input.logsFileId))` branch (ensureLogsFileExists), the same way the
                // provisioning-throw path above passes it.
                logsFileId: data.logsFileId,
            })
            // A handled outcome, not an error needing a retry — returning INTERNAL_ERROR here would
            // burn a second BullMQ attempt (and its ~8 minute backoff) on a run that has already been
            // failed explicitly and reported to its caller.
            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.OK }
        }

        const timeoutInSeconds = workerSettings.getSettings().FLOW_TIMEOUT_SECONDS

        const flowVersion = await flowCache(ctx.log, ctx.apiClient).getVersion({ flowVersionId: data.flowVersionId })
        if (isNil(flowVersion)) {
            ctx.log.info({ flowVersionId: data.flowVersionId }, 'Flow version not found, skipping')
            await reportFlowStatus({ ctx, data, status: FlowRunStatus.FAILED })
            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.INTERNAL_ERROR }
        }

        const { data: provisioned, error: provisionError } = await tryCatch(() => provisionFlowPieces({ flowVersion, platformId: data.platformId, flowId: data.flowId, projectId: data.projectId, log: ctx.log, apiClient: ctx.apiClient }))
        if (provisionError) {
            await reportFlowStatus({ ctx, data, status: FlowRunStatus.INTERNAL_ERROR, internalError: toInternalError(RunInternalErrorSource.WORKER, provisionError), logsFileId: data.logsFileId })
            throw provisionError
        }
        if (!provisioned.provisioned) {
            await reportFlowStatus({ ctx, data, status: FlowRunStatus.FAILED })
            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.INTERNAL_ERROR }
        }

        if (data.executionType === ExecutionType.RESUME && isNil(data.logsFileId)) {
            const resumeLogsFileMissingError = new QadamFlowError({
                code: ErrorCode.RESUME_LOGS_FILE_MISSING,
                params: { runId: data.runId },
            }, 'logsFileId is missing for RESUME operation')
            await reportFlowStatus({ ctx, data, status: FlowRunStatus.INTERNAL_ERROR, internalError: toInternalError(RunInternalErrorSource.WORKER, resumeLogsFileMissingError) })
            throw resumeLogsFileMissingError
        }

        const sandbox = ctx.sandboxManager.acquire({
            log: ctx.log,
            apiClient: ctx.apiClient,
            jobContext: {
                runId: data.runId,
                projectId: data.projectId,
                platformId: data.platformId,
                environment: data.environment,
                workerHandlerId: data.workerHandlerId ?? null,
                httpRequestId: data.httpRequestId ?? null,
            },
        })
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

            if (result.status === EngineResponseStatus.LOG_SIZE_EXCEEDED) {
                await reportFlowStatus({ ctx, data, status: FlowRunStatus.LOG_SIZE_EXCEEDED, logsFileId: data.logsFileId })
                return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.LOG_SIZE_EXCEEDED, logs: result.logs }
            }

            if (result.status === EngineResponseStatus.INTERNAL_ERROR) {
                await reportFlowStatus({
                    ctx,
                    data,
                    status: FlowRunStatus.INTERNAL_ERROR,
                    internalError: {
                        source: RunInternalErrorSource.ENGINE,
                        message: result.error ?? 'Engine reported an internal error without details',
                        occurredAt: new Date().toISOString(),
                    },
                    logsFileId: data.logsFileId,
                })
                return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.INTERNAL_ERROR, logs: result.logs }
            }

            return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.OK, logs: result.logs }
        }
        catch (e) {
            await ctx.sandboxManager.invalidate(ctx.log)
            if (e instanceof QadamFlowError) {
                if (e.error.code === ErrorCode.SANDBOX_EXECUTION_TIMEOUT) {
                    await reportFlowStatus({ ctx, data, status: FlowRunStatus.TIMEOUT, logsFileId: data.logsFileId })
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.TIMEOUT }
                }
                if (e.error.code === ErrorCode.SANDBOX_MEMORY_ISSUE) {
                    await reportFlowStatus({ ctx, data, status: FlowRunStatus.MEMORY_LIMIT_EXCEEDED, logsFileId: data.logsFileId })
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.MEMORY_ISSUE }
                }
                if (e.error.code === ErrorCode.SANDBOX_LOG_SIZE_EXCEEDED) {
                    await reportFlowStatus({ ctx, data, status: FlowRunStatus.LOG_SIZE_EXCEEDED, logsFileId: data.logsFileId })
                    return { kind: JobResultKind.FIRE_AND_FORGET, status: EngineResponseStatus.LOG_SIZE_EXCEEDED }
                }
            }
            await reportFlowStatus({ ctx, data, status: FlowRunStatus.INTERNAL_ERROR, internalError: toInternalError(RunInternalErrorSource.WORKER, e), logsFileId: data.logsFileId })
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
        logsFileId: data.logsFileId,
        timeoutInSeconds,
        platformId: data.platformId,
        engineToken: ctx.engineToken,
        internalApiUrl: ctx.internalApiUrl,
        publicApiUrl: ctx.publicApiUrl,
        inheritedRunLocale: data.inheritedRunLocale,
    }

    if (data.executionType === ExecutionType.RESUME) {
        return {
            ...base,
            executionType: ExecutionType.RESUME,
            resumePayload: data.payload,
            resumeReason: data.resumeReason,
        }
    }

    return {
        ...base,
        executionType: ExecutionType.BEGIN,
        triggerPayload: data.payload,
        executeTrigger: data.executeTrigger ?? false,
        sampleData: data.sampleData,
    }
}

function toInternalError(source: RunInternalErrorSource, error: unknown): RunInternalError {
    const isApError = error instanceof QadamFlowError
    const base = error instanceof Error
        ? [error.name, error.message, error.stack].filter(Boolean).join('\n')
        : inspect(error, { depth: 1 })
    return {
        source,
        message: base,
        code: isApError ? error.error.code : undefined,
        occurredAt: new Date().toISOString(),
    }
}

/**
 * Every caller of `reportFlowStatus` is a terminal failure the engine never got to report itself
 * (missing flow version, provisioning failure, sandbox timeout, OOM, engine internal error). Without
 * a response the sync HTTP caller blocks for the full AP_WEBHOOK_TIMEOUT_SECONDS and then receives
 * the watcher's timeout default, a 504 that tells it the run may still be going (#509).
 *
 * The engine sends its own failure response when it survives long enough (flow.operation.ts); a
 * double publish is harmless, since the watcher drops its listener after the first message. The body
 * carries no internal detail, not even the terminal status — this endpoint is reachable by anyone
 * holding the flow id, and which resource limit a run hit is not theirs to probe for.
 *
 * The terminal-failure check is redundant against today's call sites and deliberately kept: a future
 * caller passing PAUSED would otherwise answer 500 to a run that is merely waiting to resume, whose
 * response belongs to the waitpoint machinery.
 *
 * No `runId` either. The legacy resume route (`/:id/requests/:requestId`) accepts the run id alone
 * as its credential, and a failed run does not stay terminal: a FROM_FAILED_STEP retry requeues the
 * same row, which can then pause and be resumed by whoever holds the id. A webhook caller correlates
 * through the `x-webhook-id` header instead; a resume caller already has the id.
 */
async function respondToSyncCallerOnFailure({ ctx, data, status }: RespondToSyncCallerParams): Promise<void> {
    const { workerHandlerId, httpRequestId } = data
    if (isNil(workerHandlerId) || isNil(httpRequestId)) {
        return
    }
    const terminalFailure = status !== FlowRunStatus.SUCCEEDED
        && isFlowRunStateTerminal({ status, ignoreInternalError: false })
    if (!terminalFailure) {
        return
    }
    const { error } = await tryCatch(() => ctx.apiClient.sendFlowResponse({
        workerHandlerId,
        httpRequestId,
        runResponse: {
            status: 500,
            body: {
                message: 'The flow run did not complete successfully.',
            },
            headers: {},
        },
    }))
    if (!isNil(error)) {
        // The run's own status upload matters more — leaving the caller to time out is exactly the
        // behaviour that existed before this response was sent at all.
        ctx.log.error({ runId: data.runId, error: inspect(error) }, 'Failed to send the failure response to the sync caller')
    }
}

async function reportFlowStatus({ ctx, data, status, internalError, logsFileId }: ReportFlowStatusParams): Promise<void> {
    await respondToSyncCallerOnFailure({ ctx, data, status })

    await ctx.apiClient.uploadRunLog({
        runId: data.runId,
        status,
        projectId: data.projectId,
        streamStepProgress: data.streamStepProgress,
        finishTime: new Date().toISOString(),
        logsFileId,
        internalError,
    })

    if (status === FlowRunStatus.INTERNAL_ERROR && isDedicatedWorker()) {
        onCallService(ctx.log, workerSettings.getSettings().PAGE_ONCALL_WEBHOOK).page({
            code: ErrorCode.ENGINE_OPERATION_FAILURE,
            message: `Flow run ${data.runId} ended with INTERNAL_ERROR`,
            params: { runId: data.runId, flowId: data.flowId, projectId: data.projectId },
        }).catch((e) => ctx.log.error({ runId: data.runId, error: inspect(e) }, 'Failed to send on-call page for INTERNAL_ERROR'))
    }
}

function isDedicatedWorker(): boolean {
    return !isNil(system.get(WorkerSystemProp.WORKER_GROUP_ID))
}

type RespondToSyncCallerParams = {
    ctx: JobContext
    data: ExecuteFlowJobData
    status: FlowRunStatus
}

type ReportFlowStatusParams = {
    ctx: JobContext
    data: ExecuteFlowJobData
    status: FlowRunStatus
    internalError?: RunInternalError
    // Omitted on paths where the engine never started and there is nothing to persist:
    // no log file was uploaded under this id, and sending it would violate
    // fk_flow_run_logs_file_id and discard the whole status write, stranding the run
    // at QUEUED. Kept wherever the engine may have run, and on the provisioning-throw
    // path, where the internalError detail is only reachable via the logs file.
    logsFileId?: string
}

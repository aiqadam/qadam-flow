import { promisify } from 'node:util'
import { zstdCompress as zstdCompressCallback } from 'node:zlib'
import {
    EngineGenericError,
    ExecutionType,
    FileCompression,
    FileType,
    FlowRunStatus,
    flowStructureUtil,
    GenericStepOutput,
    isFlowRunStateTerminal,
    isNil,
    logSerializer,
    StepOutputStatus,
    tryCatch,
    UploadRunLogsRequest,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { engineFileApi } from '../engine-file-api'
import { utils } from '../utils'
import { workerSocket } from '../worker-socket'
import { EngineConstants } from './context/engine-constants'
import { FlowExecutorContext } from './context/flow-execution-context'
import { flowExecutor } from './flow-executor'

const zstdCompress = promisify(zstdCompressCallback)

// Runs a `callFlow` "inline" target as a normal nested flow execution, in the SAME
// engine process as the parent — no queue job, no new sandbox, no waitpoint/HTTP
// round trip. Trust boundary: the target flow, its pieces already being provisioned,
// and the child FlowRun row are all resolved by the WORKER (via resolveInlineFlow),
// which scopes and depth-guards them from ITS OWN trusted job context — this
// function never has to (and must never) trust a flowId's ownership on its own.
export async function callFlowInline(params: { constants: EngineConstants, flowId: string, payload: unknown }): Promise<CallFlowInlineResult> {
    const { constants: parentConstants, flowId, payload } = params

    const resolved = await utils.tryCatchAndThrowOnEngineError(() =>
        // `parentRunId: parentConstants.flowRunId` is the run THIS call is nested
        // under — for a top-level callFlow that's the job's own run; for a nested
        // inline call (a child calling another child inline) it's the immediate
        // parent's run, not the outermost job's. Anchoring the depth guard on
        // anything job-level instead of this would let cyclic inline flows
        // (A calls B inline, B calls A inline, ...) recurse unbounded within one
        // process, since every nested call would report the same ancestor.
        workerSocket.getWorkerClient().resolveInlineFlow({ flowId, payload, parentRunId: parentConstants.flowRunId }),
    )
    if (resolved.error) {
        throw new EngineGenericError('ResolveInlineFlowError', 'Failed to resolve inline subflow', resolved.error)
    }
    if (!resolved.data.ok) {
        throw new Error(resolved.data.error)
    }
    const { flowVersion, childRunId, childLogsFileId } = resolved.data

    const runEnvironment = parentConstants.runEnvironment
    if (isNil(runEnvironment)) {
        throw new EngineGenericError('MissingRunEnvironmentError', 'Parent run has no environment set; cannot execute an inline subflow')
    }

    // Matches the envelope `callableFlow.run()` hands back on the queue path
    // (`{ data: <payload>, callbackUrl }`, from the raw webhook POST body callFlow's
    // queue branch sends) — callFlow's existing templates read `trigger.output.data.*`
    // regardless of which execution mode produced the trigger step.
    const triggerOutput = { data: payload, callbackUrl: undefined }

    const childConstants = new EngineConstants({
        flowId: flowVersion.flowId,
        flowVersionId: flowVersion.id,
        flowVersionState: flowVersion.state,
        triggerQadamName: flowVersion.trigger.settings.qadamName,
        flowRunId: childRunId,
        publicApiUrl: parentConstants.publicApiUrl,
        internalApiUrl: parentConstants.internalApiUrl,
        retryConstants: parentConstants.retryConstants,
        engineToken: parentConstants.engineToken,
        projectId: parentConstants.projectId,
        streamStepProgress: parentConstants.streamStepProgress,
        workerHandlerId: null,
        httpRequestId: null,
        runEnvironment,
        logsFileId: childLogsFileId,
        timeoutInSeconds: parentConstants.timeoutInSeconds,
        platformId: parentConstants.platformId,
        stepNames: flowStructureUtil.getAllSteps(flowVersion.trigger).map((step) => step.name),
        isInlineChild: true,
        inlineDepth: parentConstants.inlineDepth + 1,
    })

    const withTriggerStep = await FlowExecutorContext.empty({
        engineApi: { engineToken: childConstants.engineToken, internalApiUrl: childConstants.internalApiUrl },
    }).upsertStep(flowVersion.trigger.name, GenericStepOutput.create({
        type: flowVersion.trigger.type,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
    }).setOutput(triggerOutput))

    // Any failure past this point (including an unexpected engine-level throw, not
    // just a normal FAILED verdict) still needs the child FlowRun row finalized —
    // it was already created by resolveInlineFlow, and nothing else in the codebase
    // reaps a run stuck RUNNING forever.
    let finalContext: FlowExecutorContext
    try {
        finalContext = (await flowExecutor.executeFromTrigger({
            executionState: withTriggerStep,
            constants: childConstants,
            input: {
                flowVersion,
                executionType: ExecutionType.BEGIN,
                triggerPayload: triggerOutput,
                executeTrigger: false,
                flowRunId: childRunId,
                projectId: childConstants.projectId,
                engineToken: childConstants.engineToken,
                internalApiUrl: childConstants.internalApiUrl,
                publicApiUrl: childConstants.publicApiUrl,
                timeoutInSeconds: childConstants.timeoutInSeconds,
                platformId: childConstants.platformId,
                runEnvironment,
                workerHandlerId: null,
                httpRequestId: null,
                streamStepProgress: childConstants.streamStepProgress,
                stepNameToTest: null,
            },
        })).finishExecution()
    }
    catch (error) {
        await finalizeInlineChildRunOnUnexpectedError({ constants: childConstants })
        throw error
    }

    await finalizeInlineChildRun({ constants: childConstants, finalContext })

    return toCallFlowResult(finalContext)
}

function toCallFlowResult(finalContext: FlowExecutorContext): CallFlowInlineResult {
    const verdict = finalContext.verdict
    if (verdict.status === FlowRunStatus.PAUSED) {
        throw new Error('This flow cannot be called with Execution Mode "Inline" because it pauses (Delay, Human Input, Approval, or a nested Queue-mode Call Flow). Use "Queue" execution mode for this subflow instead.')
    }
    if (verdict.status === FlowRunStatus.FAILED || verdict.status === FlowRunStatus.LOG_SIZE_EXCEEDED) {
        return { status: 'error', data: verdict.failedStep.message }
    }
    if (verdict.status === FlowRunStatus.SUCCEEDED && !isNil(verdict.stopResponse)) {
        const { status, data } = readRespondBody(verdict.stopResponse.body)
        return { status: status ?? 'success', data }
    }
    return { status: 'success', data: undefined }
}

function readRespondBody(body: unknown): { status: string | undefined, data: unknown } {
    if (typeof body !== 'object' || isNil(body)) {
        return { status: undefined, data: undefined }
    }
    const record = body as Record<string, unknown>
    return {
        status: typeof record.status === 'string' ? record.status : undefined,
        data: record.data,
    }
}

async function finalizeInlineChildRun(params: { constants: EngineConstants, finalContext: FlowExecutorContext }): Promise<void> {
    const { constants, finalContext } = params
    const logsFileId = constants.logsFileId
    if (isNil(logsFileId)) {
        throw new EngineGenericError('MissingLogsFileIdError', 'Inline child run has no logsFileId set')
    }
    const status = finalContext.verdict.status
    const isTerminal = isFlowRunStateTerminal({ status, ignoreInternalError: false })

    const serialized = await logSerializer.serialize({
        executionState: {
            steps: finalContext.steps,
            tags: Array.from(finalContext.tags),
        },
    })
    const compressed = await zstdCompress(serialized)

    await engineFileApi.upload({
        engineToken: constants.engineToken,
        apiUrl: constants.internalApiUrl,
        fileId: logsFileId,
        type: FileType.FLOW_RUN_LOG,
        compression: FileCompression.ZSTD,
        data: compressed,
    })

    const request: UploadRunLogsRequest = {
        runId: constants.flowRunId,
        projectId: constants.projectId,
        status,
        logsFileId,
        failedStep: 'failedStep' in finalContext.verdict ? finalContext.verdict.failedStep : undefined,
        finishTime: isTerminal ? dayjs().toISOString() : undefined,
        tags: Array.from(finalContext.tags),
        stepsCount: finalContext.stepsCount,
    }
    const { error } = await tryCatch(() => workerSocket.getWorkerClient().uploadRunLog(request))
    if (error) {
        throw new EngineGenericError('FinalizeInlineFlowRunError', 'Failed to finalize inline subflow run', error)
    }
}

async function finalizeInlineChildRunOnUnexpectedError(params: { constants: EngineConstants }): Promise<void> {
    const { constants } = params
    await tryCatch(() => workerSocket.getWorkerClient().uploadRunLog({
        runId: constants.flowRunId,
        projectId: constants.projectId,
        status: FlowRunStatus.INTERNAL_ERROR,
        finishTime: dayjs().toISOString(),
    }))
}

export type CallFlowInlineResult = {
    status: string
    data: unknown
}

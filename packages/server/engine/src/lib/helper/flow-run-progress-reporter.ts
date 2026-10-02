import { promisify } from 'node:util'
import { zstdCompress as zstdCompressCallback } from 'node:zlib'
import { setTimeout } from 'timers/promises'
import { OutputContext } from '@aiqadam/qadams-framework'
import { DEFAULT_MCP_DATA, EngineGenericError, FileCompression, FileType, FlowActionType, FlowRunStatus, GenericStepOutput, isFlowRunStateTerminal, isNil, logSerializer, RunEnvironment, StepOutputStatus, StepRunResponse, tryCatch, UpdateRunProgressRequest, UploadRunLogsRequest } from '@aiqadam/shared'
import { Mutex } from 'async-mutex'
import dayjs from 'dayjs'
import { engineFileApi } from '../engine-file-api'
import { EngineConstants } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { retryingFetch, RetryPolicy } from '../retrying-fetch'
import { utils } from '../utils'
import { workerSocket } from '../worker-socket'


const zstdCompress = promisify(zstdCompressCallback)
const stateLock = new Mutex()

// A production run reaches the server only through these snapshots, so the interval is how far the
// live run view trails the engine (#580). Each flush re-uploads the whole log and enqueues a
// runs-metadata job, so a log past the threshold keeps the old 15 s cadence.
const SMALL_LOG_FLUSH_INTERVAL_MS = 2000
const LARGE_LOG_FLUSH_INTERVAL_MS = 15000
const LARGE_LOG_THRESHOLD_BYTES = 1024 * 1024
let latestUpdateParams: UpdateStepProgressParams | null = null
// Set by every accepted sendUpdate, cleared by a successful upload. The periodic loop uploads only
// while it is set, so a step that waits for minutes costs nothing until something changes.
let snapshotDirty = false
let lastSerializedBytes = 0
let savedStartTime: string | null = null
let flushController: AbortController | null = null
let flushLoopPromise: Promise<void> | null = null

export const flowRunProgressReporter = {
    init: (): void => {
        if (flushController) {
            return
        }
        flushController = new AbortController()
        flushLoopPromise = runFlushLoop(flushController.signal)
    },
    sendUpdate: async (params: UpdateStepProgressParams): Promise<void> => {
        return stateLock.runExclusive(async () => {
            const { engineConstants, flowExecutorContext, stepNameToUpdate } = params
            // Inline `callFlow` children run their own trigger/step loop through this
            // same reporter, in the same process, as the parent. The module-level
            // `latestUpdateParams`/backup() below track exactly one "current" run — if a
            // child's updates were allowed through, its progress would overwrite the
            // parent's, and a periodic/`backup()` flush could persist the child's steps
            // into the parent's own log file. Children get a full step-log snapshot of
            // their own from `inline-flow-executor.ts` instead once they finish. An agent tool's
            // one-step execution carries its parent's run id (#643) but is not a step of that run:
            // letting it through would replace the parent's snapshot with the tool's lone step.
            if (engineConstants.isInlineChild || engineConstants.isAgentToolCall) {
                return
            }
            if (params.startTime) {
                savedStartTime = params.startTime
            }
            // A loop iteration reports its steps, but its verdict is not the run's: a failed item the
            // loop goes on from (CONTINUE, or a rate-limit retry) would otherwise reach the server as
            // a FAILED run in the next flush — failing a subflow's parent and firing run-finished
            // side effects mid-run. The loop reports the merged verdict itself.
            const reportedContext = flowExecutorContext.isIterationFork
                ? flowExecutorContext.setVerdict({ status: FlowRunStatus.RUNNING })
                : flowExecutorContext
            latestUpdateParams = { ...params, flowExecutorContext: reportedContext }
            snapshotDirty = true
            if (!stepNameToUpdate || !engineConstants.isTestFlow) { // live runs are updated by backup job
                return
            }
            const step = flowExecutorContext.getStepOutput(stepNameToUpdate)
            if (isNil(step)) {
                return
            }
            await sendUpdateProgress({
                step: {
                    name: stepNameToUpdate,
                    path: flowExecutorContext.currentPath.path,
                    output: step,
                },
                flowRun: {
                    projectId: engineConstants.projectId,
                    flowId: engineConstants.flowId,
                    flowVersionId: engineConstants.flowVersionId,
                    id: engineConstants.flowRunId,
                    created: dayjs().toISOString(),
                    updated: dayjs().toISOString(),
                    status: reportedContext.verdict.status,
                    environment: engineConstants.runEnvironment ?? RunEnvironment.TESTING,
                    failParentOnFailure: false,
                    triggeredBy: engineConstants.triggerQadamName,
                    tags: Array.from(flowExecutorContext.tags),
                    startTime: params.startTime,
                },
            })
        })
    },
    createOutputContext: (params: CreateOutputContextParams): OutputContext => {
        const { engineConstants, flowExecutorContext, stepName, stepOutput } = params
        return {
            update: async (params: { data: unknown }) => {
                // The tool's step is not a step of the run whose id it carries (#643).
                if (engineConstants.isAgentToolCall) {
                    return
                }
                const updated = await flowExecutorContext
                    .upsertStep(stepName, stepOutput.setOutput(params.data))

                const stepResponse = extractStepResponse({
                    flowExecutorContext: updated,
                    runId: engineConstants.flowRunId,
                    stepName,
                })
                if (stepResponse) {
                    await workerSocket.getWorkerClient().updateStepProgress({
                        projectId: engineConstants.projectId,
                        stepResponse: {
                            ...stepResponse,
                            output: params.data,
                        },
                    })
                }
            },
        }
    },
    // The final snapshot is the run's result, so it waits out an app restart (#595). A best-effort
    // one gives up sooner: it holds the lock every step's progress update needs, and the periodic
    // loop uploads again on its next tick anyway.
    backup: async ({ bestEffort = false }: BackupParams = {}): Promise<void> => {
        await flushSnapshot({ onlyIfDirty: false, retryPolicy: bestEffort ? retryingFetch.bestEffortPolicy : retryingFetch.defaultPolicy })
    },
    flushIfDirty: async (): Promise<void> => {
        await flushSnapshot({ onlyIfDirty: true, retryPolicy: retryingFetch.bestEffortPolicy })
    },
    nextFlushDelayMs: (): number => {
        return lastSerializedBytes > LARGE_LOG_THRESHOLD_BYTES ? LARGE_LOG_FLUSH_INTERVAL_MS : SMALL_LOG_FLUSH_INTERVAL_MS
    },
    shutdown: async () => {
        if (flushController) {
            flushController.abort()
        }

        if (flushLoopPromise) {
            await flushLoopPromise
        }

        flushController = null
        flushLoopPromise = null
        latestUpdateParams = null
        savedStartTime = null
        snapshotDirty = false
        lastSerializedBytes = 0
    },
}

process.on('SIGTERM', () => void flowRunProgressReporter.shutdown())
process.on('SIGINT', () => void flowRunProgressReporter.shutdown())

async function flushSnapshot({ onlyIfDirty, retryPolicy }: FlushSnapshotParams): Promise<void> {
    await stateLock.runExclusive(async () => {
        const params = latestUpdateParams
        if (isNil(params)) {
            return
        }
        if (onlyIfDirty && !snapshotDirty) {
            return
        }
        const { flowExecutorContext, engineConstants } = params
        // Defence in depth: nothing produces the placeholder run id since #643, but a run that is
        // not a run must never be flushed as one.
        if (engineConstants.flowRunId === DEFAULT_MCP_DATA.flowRunId) {
            return
        }
        const status = flowExecutorContext.verdict.status
        const isTerminal = isFlowRunStateTerminal({ status, ignoreInternalError: false })

        const serialized = await logSerializer.serialize({
            executionState: {
                steps: flowExecutorContext.stepsForLog(),
                tags: Array.from(flowExecutorContext.tags),
            },
        })
        const executionState = await zstdCompress(serialized)

        const logsFileId = engineConstants.logsFileId
        if (isNil(logsFileId)) {
            throw new EngineGenericError('LogsFileIdNotSetError', 'Logs file id is not set')
        }
        await engineFileApi.upload({
            engineToken: engineConstants.engineToken,
            apiUrl: engineConstants.internalApiUrl,
            fileId: logsFileId,
            type: FileType.FLOW_RUN_LOG,
            compression: FileCompression.ZSTD,
            data: executionState,
            retryPolicy,
        })

        const stepResponse = extractStepResponse({
            flowExecutorContext,
            runId: engineConstants.flowRunId,
            stepName: engineConstants.stepNameToTest,
        })

        const request: UploadRunLogsRequest = {
            runId: engineConstants.flowRunId,
            projectId: engineConstants.projectId,
            status,
            streamStepProgress: engineConstants.streamStepProgress,
            logsFileId: engineConstants.logsFileId,
            failedStep: 'failedStep' in flowExecutorContext.verdict ? flowExecutorContext.verdict.failedStep : undefined,
            stepNameToTest: engineConstants.stepNameToTest,
            stepResponse,
            startTime: savedStartTime ?? undefined,
            finishTime: isTerminal ? dayjs().toISOString() : undefined,
            tags: Array.from(flowExecutorContext.tags),
            stepsCount: flowExecutorContext.stepsCount,
        }
        await sendLogsUpdate(request)
        snapshotDirty = false
        lastSerializedBytes = serialized.length
    })
}

async function runFlushLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        const { error: flushError } = await tryCatch(() => flowRunProgressReporter.flushIfDirty())
        if (flushError) {
            console.error('[Progress] Snapshot flush failed', flushError)
        }

        // sleep aborted → loop will exit naturally on the next signal check
        await tryCatch(() => setTimeout(flowRunProgressReporter.nextFlushDelayMs(), undefined, { signal }))
    }
}

const sendUpdateProgress = async (request: UpdateRunProgressRequest): Promise<void> => {
    const result = await utils.tryCatchAndThrowOnEngineError(() =>
        workerSocket.getWorkerClient().updateRunProgress(request),
    )
    if (result.error) {
        throw new EngineGenericError('ProgressUpdateError', 'Failed to send updateRunProgress', result.error)
    }
}

const sendLogsUpdate = async (request: UploadRunLogsRequest): Promise<void> => {
    const result = await utils.tryCatchAndThrowOnEngineError(() =>
        workerSocket.getWorkerClient().uploadRunLog(request),
    )
    if (result.error) {
        throw new EngineGenericError('ProgressUpdateError', 'Failed to send uploadRunLog', result.error)
    }
}

const extractStepResponse = (params: ExtractStepResponse): StepRunResponse | undefined => {
    if (isNil(params.stepName)) {
        return undefined
    }

    const stepOutput = params.flowExecutorContext.getStepOutput(params.stepName)
    if (isNil(stepOutput)) {
        return undefined
    }
    const isSuccess = stepOutput.status === StepOutputStatus.SUCCEEDED || stepOutput.status === StepOutputStatus.PAUSED
    return {
        runId: params.runId,
        success: isSuccess,
        input: stepOutput.input,
        output: stepOutput.output,
        standardError: isSuccess ? '' : (stepOutput.errorMessage as string),
        standardOutput: '',
    }
}

type UpdateStepProgressParams = {
    engineConstants: EngineConstants
    flowExecutorContext: FlowExecutorContext
    stepNameToUpdate?: string
    startTime?: string
}

type CreateOutputContextParams = {
    engineConstants: EngineConstants
    flowExecutorContext: FlowExecutorContext
    stepName: string
    stepOutput: GenericStepOutput<FlowActionType.PIECE, unknown>
}

type FlushSnapshotParams = {
    onlyIfDirty: boolean
    retryPolicy: RetryPolicy
}

type BackupParams = {
    bestEffort?: boolean
}

type ExtractStepResponse = {
    flowExecutorContext: FlowExecutorContext
    runId: string
    stepName?: string
}

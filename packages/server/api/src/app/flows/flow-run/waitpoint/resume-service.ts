import {
    apId,
    EngineHttpResponse,
    ErrorCode,
    ExecutionType,
    FlowRun,
    FlowRunId,
    FlowRunStatus,
    isFlowRunStateTerminal,
    QadamFlowError,
    ResumeReason,
    RunEnvironment,
    StreamStepProgress,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { projectService } from '../../../project/project-service'
import { engineResponseWatcher } from '../../../workers/engine-response-watcher'
import { addToQueue, findFlowRunOrThrow, flowRunService, WEBHOOK_TIMEOUT_MS } from '../flow-run-service'
import { flowRunSideEffects } from '../flow-run-side-effects'
import { waitpointService } from './waitpoint-service'
import { Waitpoint, WaitpointResumePayload } from './waitpoint-types'

export const resumeService = (log: FastifyBaseLogger) => ({
    async resumeFromWaitpoint({ flowRunId, waitpointId, resumePayload, workerHandlerId, httpRequestId }: ResumeFromWaitpointParams): Promise<ResumeFromWaitpointResult> {
        // A resume POST can legitimately arrive after its own flow run's row
        // is gone from under it — not because the run never existed, but
        // because a slow-to-respond original request raced a client-side
        // timeout: the client retried, the retry lands after the original
        // request already finished resuming/deleting everything, and by then
        // even the parent flow_run lookup can come up empty under load. That
        // is exactly the same "stale, not an error" case handleResumeSignal
        // already treats as benign below — ENTITY_NOT_FOUND here deserves
        // the same tolerance, not a 404 that fails the calling flow.
        const { data: flowRun, error: notFound } = await tryCatch(() => findFlowRunOrThrow(flowRunId))
        if (notFound) {
            if (notFound instanceof QadamFlowError && notFound.error.code === ErrorCode.ENTITY_NOT_FOUND) {
                log.info({ flowRunId, waitpointId }, '[resumeService#resumeFromWaitpoint] Flow run no longer exists, treating resume as stale')
                return { flowRun: undefined, stale: true }
            }
            throw notFound
        }
        const processed = await waitpointService(log).handleResumeSignal({
            flowRunId,
            waitpointId,
            flowRunStatus: flowRun.status,
            projectId: flowRun.projectId,
            resumePayload: resumePayload ?? null,
            workerHandlerId,
            onReady: async (waitpoint) => {
                await enqueueResume({
                    flowRun,
                    waitpoint,
                    resumePayload,
                    workerHandlerId,
                    httpRequestId,
                }, log)
            },
        })
        return { flowRun, stale: !processed }
    },

    async legacyResume({ flowRunId, resumePayload, workerHandlerId }: LegacyResumeParams): Promise<ResumeFromWaitpointResult> {
        const flowRun = await findFlowRunOrThrow(flowRunId)
        if (flowRun.status !== FlowRunStatus.PAUSED) {
            return { flowRun, stale: true }
        }
        await enqueueResume({ flowRun, resumePayload, workerHandlerId }, log)
        return { flowRun, stale: false }
    },

    async handleSyncResumeFlow({ runId, waitpointId, payload, correlationId }: HandleSyncResumeFlowParams): Promise<EngineHttpResponse> {
        const flowRun = await flowRunService(log).getOnePopulatedOrThrow({
            id: runId,
            projectId: undefined,
        })

        if (isFlowRunStateTerminal({ status: flowRun.status, ignoreInternalError: false })) {
            return {
                status: StatusCodes.CONFLICT,
                body: { message: 'Flow run is not paused', flowRunStatus: flowRun.status },
                headers: {},
            }
        }

        const syncServerId = engineResponseWatcher(log).getServerId()
        const { stale } = await this.resumeFromWaitpoint({
            flowRunId: runId,
            waitpointId,
            resumePayload: payload,
            workerHandlerId: syncServerId,
            httpRequestId: correlationId,
        })

        if (stale) {
            return {
                status: StatusCodes.GONE,
                body: { message: 'This link has expired. The action may have already been processed.' },
                headers: {},
            }
        }

        return engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, {
            status: StatusCodes.NO_CONTENT,
            body: {},
            headers: {},
        })
    },

    async legacySyncResume({ runId, payload, correlationId }: LegacySyncResumeParams): Promise<EngineHttpResponse> {
        const flowRun = await findFlowRunOrThrow(runId)
        if (flowRun.status !== FlowRunStatus.PAUSED) {
            return {
                status: StatusCodes.CONFLICT,
                body: { message: 'Flow run is not paused', flowRunStatus: flowRun.status },
                headers: {},
            }
        }
        const syncServerId = engineResponseWatcher(log).getServerId()
        await enqueueResume({ flowRun, resumePayload: payload, workerHandlerId: syncServerId, httpRequestId: correlationId }, log)
        return engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, {
            status: StatusCodes.NO_CONTENT,
            body: {},
            headers: {},
        })
    },
})

async function enqueueResume(params: EnqueueResumeParams, log: FastifyBaseLogger): Promise<void> {
    const { flowRun, waitpoint, resumePayload, workerHandlerId, httpRequestId } = params
    const platformId = await projectService(log).getPlatformId(flowRun.projectId)
    await addToQueue({
        payload: resumePayload,
        flowRun,
        platformId,
        workerHandlerId: workerHandlerId ?? waitpoint?.workerHandlerId ?? undefined,
        httpRequestId: httpRequestId ?? waitpoint?.httpRequestId ?? apId(),
        streamStepProgress: flowRun.environment === RunEnvironment.TESTING
            ? StreamStepProgress.WEBSOCKET
            : StreamStepProgress.NONE,
        executionType: ExecutionType.RESUME,
        resumeReason: ResumeReason.WAITPOINT,
    }, log)
    await flowRunSideEffects(log).onResume(flowRun)
}

type SyncResumePayload = {
    body?: unknown
    headers?: Record<string, string>
    queryParams?: Record<string, string>
}

type HandleSyncResumeFlowParams = {
    runId: string
    waitpointId: string
    payload: SyncResumePayload
    correlationId: string
}

type LegacySyncResumeParams = {
    runId: string
    payload: SyncResumePayload
    correlationId: string
}

type ResumeFromWaitpointParams = {
    flowRunId: FlowRunId
    waitpointId: string
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
}

type LegacyResumeParams = {
    flowRunId: FlowRunId
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
}

type ResumeFromWaitpointResult = {
    // Absent exactly when stale is true because the flow run itself was
    // gone by the time this resume was processed — see resumeFromWaitpoint.
    flowRun: FlowRun | undefined
    stale: boolean
}

type EnqueueResumeParams = {
    flowRun: FlowRun
    waitpoint?: Waitpoint
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
}

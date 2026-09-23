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
    WebhookPauseMetadata,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { projectService } from '../../../project/project-service'
import { engineResponseWatcher } from '../../../workers/engine-response-watcher'
import { addToQueue, findFlowRunOrThrow, flowRunService, LegacyResumeFlowRun, SYNC_RUN_TIMEOUT_RESPONSE, WEBHOOK_TIMEOUT_MS } from '../flow-run-service'
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
            httpRequestId,
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

    async legacyResume({ flowRun, resumePayload, workerHandlerId }: LegacyResumeParams): Promise<ResumeFromWaitpointResult> {
        // flowRun is resolved exactly once, by the controller, before either the "has a PENDING
        // V0 waitpoint" branch or this no-waitpoint branch is chosen — see
        // findFlowRunForLegacyResume's own comment for why that closes the #509-drain-lag /
        // check-then-use gap that used to exist between those two reads. There is deliberately no
        // ENTITY_NOT_FOUND tolerance here any more: the controller already proved the row exists
        // before calling this, so a missing row at this point would be a genuine error, not a
        // benign race.
        const eligible = await isEligibleForLegacyNoWaitpointResume({ flowRun, log })
        if (!eligible) {
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
        // Register the listener before enqueueing the resume: the engine can answer as soon as
        // the job is enqueued, and if that happens before oneTimeListener runs, the response is
        // delivered to nobody and the caller times out. The returned cancel() is bound to this
        // exact registration (never a key-based lookup), so every early exit below can tear it
        // down without risking cancelling a different request's listener that has since
        // registered under the same key (see engineResponseWatcher#oneTimeListener).
        const listener = engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, SYNC_RUN_TIMEOUT_RESPONSE)

        const { data, error } = await tryCatch(() => this.resumeFromWaitpoint({
            flowRunId: runId,
            waitpointId,
            resumePayload: payload,
            workerHandlerId: syncServerId,
            httpRequestId: correlationId,
        }))
        if (error) {
            listener.cancel()
            throw error
        }

        if (data.stale) {
            listener.cancel()
            return {
                status: StatusCodes.GONE,
                body: { message: 'This link has expired. The action may have already been processed.' },
                headers: {},
            }
        }

        return listener.promise
    },

    async legacySyncResume({ flowRun, payload, correlationId }: LegacySyncResumeParams): Promise<EngineHttpResponse> {
        // See legacyResume's comment above: flowRun is already resolved once by the controller,
        // so there is no ENTITY_NOT_FOUND case to tolerate here any more.
        const eligible = await isEligibleForLegacyNoWaitpointResume({ flowRun, log })
        if (!eligible) {
            return {
                status: StatusCodes.GONE,
                body: { message: 'This link has expired. The action may have already been processed.' },
                headers: {},
            }
        }
        const syncServerId = engineResponseWatcher(log).getServerId()
        const listener = engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, SYNC_RUN_TIMEOUT_RESPONSE)

        const { error } = await tryCatch(() => enqueueResume({ flowRun, resumePayload: payload, workerHandlerId: syncServerId, httpRequestId: correlationId }, log))
        if (error) {
            listener.cancel()
            throw error
        }

        return listener.promise
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

/**
 * Gate for the V0 no-waitpoint legacy branch (a run whose PENDING waitpoint lookup came back
 * empty). Since the piece-API shim (buildLegacyPauseHook, 2026-04-12) every legacy `run.pause()`
 * call creates a real V0 waitpoint row itself — and process.exit(1)s if that write fails — so a
 * run can only reach this branch with zero waitpoint rows if it was paused by a pre-shim engine.
 * All three conditions must hold, or the caller is told the link is stale:
 *
 * 1. status is PAUSED — anything else (including terminal states) is stale here, not a 409; the
 *    only place that still answers "flow run is not paused" with a 409 is the V1
 *    handleSyncResumeFlow/resumeFromWaitpoint path, which this branch is not.
 * 2. pauseMetadata parses as a pre-shim WEBHOOK pause. Nothing written to pauseMetadata since the
 *    shim shipped (grep-verified — flow-run-entity.ts's column is @deprecated and no code path
 *    writes it any more), so a shim-era or later PAUSED run has it NULL and fails this parse; only
 *    a genuine pre-shim WEBHOOK pause can pass. DELAY pauses are deliberately excluded: a DELAY
 *    pause is never resumed by this HTTP route at all — refill-paused-jobs.ts only reschedules
 *    RESUME_DELAY_WAITPOINT for a run that already has a DELAY waitpoint *row* (it skips any
 *    paused run whose waitpoint is nil or not DELAY; it never creates one). A pre-shim DELAY run
 *    that never got a waitpoint row is resumed by its original delayed job, or not at all — this
 *    route was never in that path — so a DELAY pauseMetadata reaching here is not this route's
 *    legitimate case.
 * 3. the run has no waitpoint row at all, of any status or version — not just no PENDING V0 one.
 *    A PENDING V1 (or COMPLETED/other) waitpoint means a real, narrower resume URL already exists
 *    for this run's current pause; this legacy branch must not offer a second, run-id-only way to
 *    resume it (see the resume-flow-run.test.ts "V0: should take legacy path when only V1
 *    waitpoint exists" tests for the scenario this closes).
 */
async function isEligibleForLegacyNoWaitpointResume({ flowRun, log }: IsEligibleForLegacyNoWaitpointResumeParams): Promise<boolean> {
    if (flowRun.status !== FlowRunStatus.PAUSED) {
        return false
    }
    if (!WebhookPauseMetadata.safeParse(flowRun.pauseMetadata).success) {
        return false
    }
    const hasWaitpoint = await waitpointService(log).hasAnyWaitpoint({ flowRunId: flowRun.id, projectId: flowRun.projectId })
    return !hasWaitpoint
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
    flowRun: LegacyResumeFlowRun
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
    flowRun: LegacyResumeFlowRun
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
}

type IsEligibleForLegacyNoWaitpointResumeParams = {
    flowRun: LegacyResumeFlowRun
    log: FastifyBaseLogger
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

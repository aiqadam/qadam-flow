import { ErrorCode, isNil, QadamFlowError } from '@aiqadam/shared'
import { Logger } from 'pino'
import { JobGivenUpError } from './given-up-guard'
import { SandboxJobContext } from './sandbox-manager'

/**
 * The engine is untrusted and the worker is not: every run id, project id and sync request id the
 * engine puts on a run-scoped RPC is checked here against the job the worker itself dequeued, before
 * the API ever sees it. The API forwards these fields into the runs-metadata queue and websocket
 * rooms as-is, so without this a subverted engine could rewrite any run's row in any project (#512).
 *
 * A job may speak for its own run, and for the inline `callFlow` children it spawned through
 * `resolveInlineFlow` — those child rows are created by the API in the job's own project, so the
 * project check holds for them too.
 */
export const engineRunScope = {
    create({ log, getCurrentJobContext }: CreateEngineRunScopeParams): EngineRunScope {
        // Keyed by the context object itself: `acquire()` installs a fresh one per job, so a reused
        // sandbox never inherits the previous job's children.
        const inlineChildRunIds = new WeakMap<SandboxJobContext, Set<string>>()

        return {
            recordInlineChild({ jobContext, childRunId }) {
                // Mutated in place: a loop of inline calls records one child per iteration, and
                // copying the set each time would make that quadratic.
                const known = inlineChildRunIds.get(jobContext)
                if (isNil(known)) {
                    inlineChildRunIds.set(jobContext, new Set([childRunId]))
                    return
                }
                known.add(childRunId)
            },
            assertOwnsRun({ rpc, runId, projectId }) {
                const jobContext = getCurrentJobContext()
                rejectIfGivenUp({ log, rpc, jobContext })
                const owned = !isNil(jobContext)
                    && projectId === jobContext.projectId
                    && (runId === jobContext.runId || (inlineChildRunIds.get(jobContext)?.has(runId) ?? false))
                if (!owned) {
                    rejectOutOfScope({ log, rpc, jobContext, requested: { runId, projectId } })
                }
            },
            assertOwnsSyncRequest({ workerHandlerId, httpRequestId }) {
                const jobContext = getCurrentJobContext()
                rejectIfGivenUp({ log, rpc: 'sendFlowResponse', jobContext })
                const owned = !isNil(jobContext)
                    && !isNil(jobContext.workerHandlerId)
                    && !isNil(jobContext.httpRequestId)
                    && workerHandlerId === jobContext.workerHandlerId
                    && httpRequestId === jobContext.httpRequestId
                if (!owned) {
                    rejectOutOfScope({ log, rpc: 'sendFlowResponse', jobContext, requested: { workerHandlerId, httpRequestId } })
                }
            },
        }
    },
}

// A job this worker gave up owns its run no longer: the run may be another worker's by now (#585).
function rejectIfGivenUp({ log, rpc, jobContext }: RejectIfGivenUpParams): void {
    if (jobContext?.isGivenUp?.() !== true) {
        return
    }
    log.info({ rpc, jobRunId: jobContext.runId }, '[engineRunScope] Dropped an engine RPC for a job this worker gave up')
    throw new JobGivenUpError(`${rpc} not sent`)
}

function rejectOutOfScope({ log, rpc, jobContext, requested }: RejectOutOfScopeParams): never {
    log.warn({
        rpc,
        requested,
        jobRunId: jobContext?.runId,
        jobProjectId: jobContext?.projectId,
    }, '[engineRunScope] Refused an engine RPC outside the current job\'s run scope')
    throw new QadamFlowError({
        code: ErrorCode.AUTHORIZATION,
        params: {
            message: `${rpc} refused: the engine asked for a run outside the current job`,
        },
    })
}

type CreateEngineRunScopeParams = {
    log: Logger
    getCurrentJobContext: () => SandboxJobContext | null
}

type RejectIfGivenUpParams = {
    log: Logger
    rpc: string
    jobContext: SandboxJobContext | null
}

type RejectOutOfScopeParams = {
    log: Logger
    rpc: string
    jobContext: SandboxJobContext | null
    requested: Record<string, string>
}

export type EngineRunScope = {
    recordInlineChild(params: { jobContext: SandboxJobContext, childRunId: string }): void
    assertOwnsRun(params: { rpc: string, runId: string, projectId: string }): void
    assertOwnsSyncRequest(params: { workerHandlerId: string, httpRequestId: string }): void
}

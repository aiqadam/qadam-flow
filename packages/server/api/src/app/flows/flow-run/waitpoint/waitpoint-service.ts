import { apId, ApId, ErrorCode, FlowRunDispatchMode, FlowRunStatus, INLINE_SUBFLOW_DEPTH_LIMIT, isNil, PauseType, QadamFlowError } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../../core/db/repo-factory'
import { transaction } from '../../../core/db/transaction'
import { SystemJobName } from '../../../helper/system-jobs/common'
import { systemJobsSchedule } from '../../../helper/system-jobs/system-job'
import { flowRunRepo } from '../flow-run-service'
import { WaitpointEntity } from './waitpoint-entity'
import { CompleteParams, CompleteResult, CreateForPauseParams, CreateForPauseResult, FindPendingByVersionParams, HandleResumeSignalParams, Waitpoint, WaitpointStatus } from './waitpoint-types'

const waitpointRepo = repoFactory(WaitpointEntity)

export const waitpointService = (log: FastifyBaseLogger) => ({
    async createForPause(params: CreateForPauseParams): Promise<CreateForPauseResult> {
        await assertCallerOwnsRun({ flowRunId: params.flowRunId, projectId: params.projectId, callerRunId: params.callerRunId, log })

        const preCompleted = await waitpointRepo().findOneBy({
            flowRunId: params.flowRunId,
            projectId: params.projectId,
            stepName: params.stepName,
            status: WaitpointStatus.COMPLETED,
        })
        if (!isNil(preCompleted)) {
            log.info({ flowRunId: params.flowRunId, stepName: params.stepName, existingStatus: preCompleted.status }, '[waitpointService#createForPause] Waitpoint already pre-completed for this step')
            return { inserted: false, waitpoint: preCompleted }
        }

        const id = apId()
        await waitpointRepo()
            .createQueryBuilder()
            .insert()
            .into('waitpoint')
            .values({
                id,
                flowRunId: params.flowRunId,
                projectId: params.projectId,
                stepName: params.stepName,
                type: params.type,
                version: params.version,
                status: WaitpointStatus.PENDING,
                resumeDateTime: params.resumeDateTime ?? null,
                responseToSend: params.responseToSend ?? null,
                workerHandlerId: params.workerHandlerId ?? null,
                httpRequestId: params.httpRequestId ?? null,
                resumePayload: null,
            })
            .orIgnore()
            .execute()

        const waitpoint = await waitpointRepo().findOneByOrFail({ flowRunId: params.flowRunId, projectId: params.projectId, stepName: params.stepName })
        const inserted = waitpoint.id === id
        if (inserted) {
            log.info({ flowRunId: params.flowRunId, waitpointId: id }, '[waitpointService#createForPause] Waitpoint created')
            if (params.type === PauseType.DELAY && !isNil(params.resumeDateTime)) {
                await systemJobsSchedule(log).upsertJob({
                    job: {
                        name: SystemJobName.RESUME_DELAY_WAITPOINT,
                        data: { flowRunId: params.flowRunId, projectId: params.projectId, waitpointId: id },
                        jobId: `resume-delay-${params.flowRunId}`,
                    },
                    schedule: {
                        type: 'one-time',
                        date: dayjs(params.resumeDateTime),
                    },
                })
            }
        }
        else {
            log.info({ flowRunId: params.flowRunId, existingStatus: waitpoint.status }, '[waitpointService#createForPause] Waitpoint already exists')
        }
        return { inserted, waitpoint }
    },

    async complete(params: CompleteParams): Promise<CompleteResult> {
        return transaction(async (entityManager) => {
            const repo = waitpointRepo(entityManager)

            const pending = await repo
                .createQueryBuilder('waitpoint')
                .setLock('pessimistic_write')
                .where({ id: params.waitpointId, flowRunId: params.flowRunId, status: WaitpointStatus.PENDING })
                .getOne()

            if (isNil(pending)) {
                log.info({ flowRunId: params.flowRunId, waitpointId: params.waitpointId }, '[waitpointService#complete] No pending waitpoint matches; dropping stale resume signal')
                return { completedExisting: false, waitpoint: null }
            }

            const updated: Waitpoint = {
                ...pending,
                status: WaitpointStatus.COMPLETED,
                resumePayload: params.resumePayload,
                workerHandlerId: params.workerHandlerId ?? pending.workerHandlerId,
                httpRequestId: params.httpRequestId ?? pending.httpRequestId,
            }
            await repo.save(updated)
            log.info({ flowRunId: params.flowRunId }, '[waitpointService#complete] Completed existing PENDING waitpoint')
            return { completedExisting: true, waitpoint: updated }
        })
    },

    async handleResumeSignal(params: HandleResumeSignalParams): Promise<boolean> {
        const { flowRunId, waitpointId, flowRunStatus, projectId, resumePayload, workerHandlerId, httpRequestId, onReady } = params

        if (flowRunStatus === FlowRunStatus.PAUSED) {
            const waitpoint = await transaction(async (entityManager) => {
                const repo = waitpointRepo(entityManager)
                const found = await repo
                    .createQueryBuilder('waitpoint')
                    .setLock('pessimistic_write')
                    .where({ id: waitpointId, flowRunId })
                    .getOne()
                if (isNil(found)) {
                    return null
                }
                await onReady(found)
                await repo.delete({ id: found.id })
                return found
            })
            if (isNil(waitpoint)) {
                log.info({ flowRunId, waitpointId }, '[waitpointService#handleResumeSignal] Stale waitpointId, ignoring')
                return false
            }
            log.info({ flowRunId, waitpointId }, '[waitpointService#handleResumeSignal] Resume triggered')
            return true
        }

        if (flowRunStatus === FlowRunStatus.RUNNING || flowRunStatus === FlowRunStatus.QUEUED) {
            const { completedExisting } = await this.complete({ flowRunId, projectId, waitpointId, resumePayload, workerHandlerId, httpRequestId })
            if (!completedExisting) {
                log.info({ flowRunId, waitpointId }, '[waitpointService#handleResumeSignal] Stale resume signal during RUNNING/QUEUED, ignoring')
                return false
            }
            log.info({ flowRunId }, '[waitpointService#handleResumeSignal] Marked PENDING waitpoint COMPLETED while flow still RUNNING/QUEUED; runsMetadataQueue will trigger resume on PAUSED upload')
            return true
        }

        log.info({ flowRunId, flowRunStatus }, '[waitpointService#handleResumeSignal] Flow run not in resumable state, ignoring')
        return false
    },

    async findPendingByVersion({ flowRunId, version }: FindPendingByVersionParams): Promise<Waitpoint | null> {
        return waitpointRepo().findOne({
            where: { flowRunId, status: WaitpointStatus.PENDING, version },
        })
    },

    async getByFlowRunId(flowRunId: string): Promise<Waitpoint | null> {
        const completed = await waitpointRepo().findOneBy({ flowRunId, status: WaitpointStatus.COMPLETED })
        return completed ?? waitpointRepo().findOneBy({ flowRunId })
    },

    async deleteByFlowRunId(flowRunId: string): Promise<void> {
        await waitpointRepo().delete({ flowRunId })
        log.info({ flowRunId }, '[waitpointService#deleteByFlowRunId] Waitpoint deleted')
    },
})

/**
 * The engine token's own id is the BullMQ job id, which for an EXECUTE_FLOW job — a fresh BEGIN
 * dispatch or a RESUME re-dispatch alike — is always the job's own top-level flow run id
 * (`jobId: params.id` in job-queue.ts, threaded through job-broker.ts#tryDequeue's
 * `jobId = job.id ?? job.name` into `generateEngineToken`). That equality check needs no database
 * round trip, so it also sidesteps the #509 ordering trap where a PRODUCTION run's own row may not
 * have reached Postgres yet when the engine pauses.
 *
 * A `callFlow` "inline" child runs in the SAME engine process and reuses the SAME engine token as
 * its parent (inline-flow-executor.ts never mints a new one), so its own flowRunId differs from
 * the token's id even for a legitimate call. An inline child can never actually complete a pause —
 * `inline-flow-executor.ts#toCallFlowResult` throws ("cannot be called with Execution Mode Inline
 * because it pauses") the moment the child's own executor returns a PAUSED verdict — but the
 * waitpoint HTTP call happens *before* that verdict is translated, so without this path the
 * legitimate attempt would fail here first with a confusing 403 instead of surfacing that accurate
 * error. isRunDescendantOfCallerJob authorizes exactly that: an unbroken chain of INLINE-dispatched
 * runs from flowRunId up to a run whose `parentRunId` is callerRunId.
 */
async function assertCallerOwnsRun(params: AssertCallerOwnsRunParams): Promise<void> {
    const { flowRunId, projectId, callerRunId, log } = params
    if (flowRunId === callerRunId) {
        return
    }
    const isInlineDescendant = await isRunDescendantOfCallerJob({ flowRunId, projectId, callerRunId })
    if (!isInlineDescendant) {
        log.warn({ flowRunId, projectId, callerRunId }, '[waitpointService#assertCallerOwnsRun] Refused a waitpoint request outside the engine token\'s own run')
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'waitpoint creation refused: the engine token may only act on its own run or a run it started inline',
            },
        })
    }
}

/**
 * Matches on `"parentRunId" = callerRunId` on any row the walk collects, rather than requiring
 * callerRunId's own row to appear as an `id` in the walk. That distinction is why this never hits
 * the #509 ordering trap either: an inline child's row is always persisted synchronously
 * (`inlineFlowRunService#start` awaits the insert), and it already carries its parent's id in its
 * own `parentRunId` column regardless of whether that parent's own row — a top-level PRODUCTION run
 * queued moments ago — has reached Postgres yet. So the walk only ever needs rows that are
 * guaranteed to exist; it never needs the caller's own possibly-unflushed row.
 *
 * Every hop, including the anchor (`flowRunId` itself), is additionally required to be
 * `dispatchMode = 'INLINE'`. That keeps this path scoped to genuine inline descendants only: a
 * QUEUE-mode child has its own job and its own engine token and must never be authorized by
 * someone else's, and a run attached via a forged public-webhook `ap-parent-run-id` header (#521)
 * is also dispatched as `QUEUE`, never `INLINE`, so it is excluded the same way.
 */
async function isRunDescendantOfCallerJob(params: IsRunDescendantOfCallerJobParams): Promise<boolean> {
    const { flowRunId, projectId, callerRunId } = params
    const query = `
        WITH RECURSIVE ancestors AS (
            SELECT id, "parentRunId", 1 AS depth
            FROM flow_run
            WHERE id = $1 AND "projectId" = $2 AND "dispatchMode" = $5

            UNION ALL

            SELECT f.id, f."parentRunId", a.depth + 1
            FROM flow_run f
            INNER JOIN ancestors a ON f.id = a."parentRunId"
            WHERE f."projectId" = $2 AND f."dispatchMode" = $5 AND a.depth < $3
        )
        SELECT 1 FROM ancestors WHERE "parentRunId" = $4 LIMIT 1
    `
    const results: unknown[] = await flowRunRepo().query(query, [flowRunId, projectId, INLINE_SUBFLOW_DEPTH_LIMIT + 1, callerRunId, FlowRunDispatchMode.enum.INLINE])
    return results.length > 0
}

type AssertCallerOwnsRunParams = {
    flowRunId: ApId
    projectId: ApId
    callerRunId: ApId
    log: FastifyBaseLogger
}

type IsRunDescendantOfCallerJobParams = {
    flowRunId: ApId
    projectId: ApId
    callerRunId: ApId
}

import { apId, ApId, ErrorCode, FlowRunDispatchMode, FlowRunStatus, INLINE_SUBFLOW_DEPTH_LIMIT, isNil, PauseType, QadamFlowError } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, IsNull, Not } from 'typeorm'
import { repoFactory } from '../../../core/db/repo-factory'
import { transaction } from '../../../core/db/transaction'
import { SystemJobName } from '../../../helper/system-jobs/common'
import { systemJobsSchedule } from '../../../helper/system-jobs/system-job'
import { flowRunRepo } from '../flow-run-service'
import { WaitpointEntity } from './waitpoint-entity'
import { WaitpointSlotEntity } from './waitpoint-slot-entity'
import { CompleteParams, CompleteResult, CreateForPauseParams, CreateForPauseResult, DeleteByFlowRunIdParams, ExistsPendingWebhookWaitpointParams, FindPendingByVersionParams, GetByFlowRunIdParams, HandleResumeSignalParams, HasAnyWaitpointParams, Waitpoint, WaitpointSlot, WaitpointSlotStatus, WaitpointStatus } from './waitpoint-types'

export const waitpointRepo = repoFactory(WaitpointEntity)
export const waitpointSlotRepo = repoFactory(WaitpointSlotEntity)

// One job per waitpoint, not per run: a durable loop (#387) creates its next DELAY waitpoint while
// the job that resumed it may still be active, and a job id already taken is silently not re-added —
// that run would never wake up again.
export const waitpointJobIds = {
    resumeDelay: ({ flowRunId, waitpointId }: { flowRunId: string, waitpointId: string }): string => `resume-delay-${flowRunId}-${waitpointId}`,
    joinTimeout: ({ waitpointId }: { waitpointId: string }): string => `join-timeout-${waitpointId}`,
}

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
            return { inserted: false, waitpoint: preCompleted, slots: [] }
        }

        const id = apId()
        // A join's slots are inserted with their waitpoint, so no child can ever see a waitpoint whose
        // slots are not there yet.
        const { waitpoint, slots } = await transaction(async (entityManager) => {
            await insertWaitpointRow({ entityManager, id, params })
            const current = await waitpointRepo(entityManager).findOneByOrFail({ flowRunId: params.flowRunId, projectId: params.projectId, stepName: params.stepName })
            if (isNil(params.join)) {
                return { waitpoint: current, slots: [] }
            }
            if (current.id === id) {
                return { waitpoint: current, slots: await insertSlots({ entityManager, waitpoint: current, count: params.join.slots }) }
            }
            return { waitpoint: current, slots: await waitpointSlotRepo(entityManager).find({ where: { waitpointId: current.id, projectId: params.projectId }, order: { slotIndex: 'ASC' } }) }
        })
        const inserted = waitpoint.id === id
        if (inserted) {
            log.info({ flowRunId: params.flowRunId, waitpointId: id, slots: slots.length }, '[waitpointService#createForPause] Waitpoint created')
            if (params.type === PauseType.DELAY && !isNil(params.resumeDateTime)) {
                await systemJobsSchedule(log).upsertJob({
                    job: {
                        name: SystemJobName.RESUME_DELAY_WAITPOINT,
                        data: { flowRunId: params.flowRunId, projectId: params.projectId, waitpointId: id },
                        jobId: waitpointJobIds.resumeDelay({ flowRunId: params.flowRunId, waitpointId: id }),
                    },
                    schedule: {
                        type: 'one-time',
                        date: dayjs(params.resumeDateTime),
                    },
                })
            }
            if (!isNil(params.join?.timeoutSeconds)) {
                await systemJobsSchedule(log).upsertJob({
                    job: {
                        name: SystemJobName.JOIN_WAITPOINT_TIMEOUT,
                        data: { flowRunId: params.flowRunId, projectId: params.projectId, waitpointId: id },
                        jobId: waitpointJobIds.joinTimeout({ waitpointId: id }),
                    },
                    schedule: {
                        type: 'one-time',
                        date: dayjs().add(params.join.timeoutSeconds, 'second'),
                    },
                })
            }
        }
        else {
            log.info({ flowRunId: params.flowRunId, existingStatus: waitpoint.status }, '[waitpointService#createForPause] Waitpoint already exists')
        }
        return { inserted, waitpoint, slots }
    },

    async complete(params: CompleteParams): Promise<CompleteResult> {
        return transaction(async (entityManager) => {
            const repo = waitpointRepo(entityManager)

            const pending = await repo
                .createQueryBuilder('waitpoint')
                .setLock('pessimistic_write')
                // A join waitpoint completes only through its slots (#374): one child's resume signal,
                // or its failure, must never complete the whole join.
                .where({ id: params.waitpointId, flowRunId: params.flowRunId, status: WaitpointStatus.PENDING, join: IsNull() })
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

    async findPendingByVersion({ flowRunId, projectId, version }: FindPendingByVersionParams): Promise<Waitpoint | null> {
        return waitpointRepo().findOne({
            where: { flowRunId, projectId, status: WaitpointStatus.PENDING, version },
        })
    },

    async getByFlowRunId({ flowRunId, projectId }: GetByFlowRunIdParams): Promise<Waitpoint | null> {
        const completed = await waitpointRepo().findOneBy({ flowRunId, projectId, status: WaitpointStatus.COMPLETED })
        return completed ?? waitpointRepo().findOneBy({ flowRunId, projectId })
    },

    async deleteByFlowRunId({ flowRunId, projectId }: DeleteByFlowRunIdParams): Promise<void> {
        await waitpointRepo().delete({ flowRunId, projectId })
        log.info({ flowRunId, projectId }, '[waitpointService#deleteByFlowRunId] Waitpoint deleted')
    },

    // Any status/version, not just PENDING V0 — the V0 legacy no-waitpoint resume branch must
    // refuse a run that has a PENDING V1 waitpoint (or even a COMPLETED one still being drained),
    // not just a PENDING V0 one. See resume-service.ts#isEligibleForLegacyNoWaitpointResume.
    async hasAnyWaitpoint({ flowRunId, projectId }: HasAnyWaitpointParams): Promise<boolean> {
        const count = await waitpointRepo().countBy({ flowRunId, projectId })
        return count > 0
    },

    /**
     * The proof behind `failParentOnFailure` (#521 impact item 3): the waitpoint id is read from
     * the request body's `callbackUrl` (see `webhook-request-converter.ts`), the same URL
     * call-flow already sends whenever it waits for a response. This proof is exactly as strong
     * as that URL itself, no stronger — whoever holds it could already resume the named run
     * directly, with or without an error — so accepting it here as proof of `failParentOnFailure`
     * grants nothing beyond what its holder can already do. Scoped to `projectId` too, though a
     * matching row could not exist under the wrong project in the first place (`createForPause`
     * always stores the waitpoint under the run's own project).
     */
    async existsPendingWebhookWaitpoint({ id, flowRunId, projectId }: ExistsPendingWebhookWaitpointParams): Promise<boolean> {
        return waitpointRepo().existsBy({ id, flowRunId, projectId, status: WaitpointStatus.PENDING, type: PauseType.WEBHOOK })
    },

    /**
     * The proof behind a child's `parentSlotId` (#374), the join counterpart of
     * `existsPendingWebhookWaitpoint`: `parentWaitpointId` must name a PENDING WEBHOOK join waitpoint
     * on the parent, and `parentSlotId` a PENDING slot of that same waitpoint. A child holding one slot
     * URL can prove only that slot — the slot id is the part of the URL no other child learns.
     */
    async findVerifiedParentJoinSlot({ parentRunId, parentWaitpointId, parentSlotId, projectId }: FindVerifiedParentJoinSlotParams): Promise<VerifiedParentJoin> {
        const waitpoint = await waitpointRepo().findOneBy({ id: parentWaitpointId, flowRunId: parentRunId, projectId, status: WaitpointStatus.PENDING, type: PauseType.WEBHOOK })
        if (isNil(waitpoint)) {
            return { waitpointProven: false, isJoin: false, slotProven: false }
        }
        if (isNil(waitpoint.join)) {
            return { waitpointProven: true, isJoin: false, slotProven: false }
        }
        const slotProven = !isNil(parentSlotId) && await waitpointSlotRepo().existsBy({ id: parentSlotId, waitpointId: waitpoint.id, projectId, status: WaitpointSlotStatus.PENDING })
        return { waitpointProven: true, isJoin: true, slotProven }
    },

    async isJoinWaitpoint({ id, flowRunId }: IsJoinWaitpointParams): Promise<boolean> {
        return waitpointRepo().exists({ where: { id, flowRunId, join: Not(IsNull()) } })
    },
})

async function insertWaitpointRow({ entityManager, id, params }: InsertWaitpointRowParams): Promise<void> {
    await waitpointRepo(entityManager)
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
            join: params.join ?? null,
        })
        .orIgnore()
        .execute()
}

async function insertSlots({ entityManager, waitpoint, count }: InsertSlotsParams): Promise<WaitpointSlot[]> {
    const now = new Date().toISOString()
    const slots: WaitpointSlot[] = Array.from({ length: count }, (_, slotIndex) => ({
        id: apId(),
        created: now,
        updated: now,
        waitpointId: waitpoint.id,
        flowRunId: waitpoint.flowRunId,
        projectId: waitpoint.projectId,
        slotIndex,
        status: WaitpointSlotStatus.PENDING,
        payload: null,
        childRunId: null,
    }))
    await waitpointSlotRepo(entityManager).insert(slots)
    return slots
}

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

type InsertWaitpointRowParams = {
    entityManager: EntityManager
    id: string
    params: CreateForPauseParams
}

type InsertSlotsParams = {
    entityManager: EntityManager
    waitpoint: Waitpoint
    count: number
}

type FindVerifiedParentJoinSlotParams = {
    parentRunId: ApId
    parentWaitpointId: ApId
    parentSlotId: ApId | undefined
    projectId: ApId
}

type VerifiedParentJoin = {
    waitpointProven: boolean
    isJoin: boolean
    slotProven: boolean
}

type IsJoinWaitpointParams = {
    id: ApId
    flowRunId: ApId
}

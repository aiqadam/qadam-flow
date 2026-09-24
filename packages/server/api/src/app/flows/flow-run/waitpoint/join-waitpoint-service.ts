import {
    FlowRunStatus,
    isNil,
    JOIN_SLOT_MAX_DATA_BYTES,
    JoinFailurePolicy,
    JoinResult,
    JoinSlotResult,
    JoinWaitpointConfig,
    sanitizeObjectForPostgresql,
    spreadIfDefined,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, IsNull, Not } from 'typeorm'
import { transaction } from '../../../core/db/transaction'
import { domainHelper } from '../../../helper/domain-helper'
import { resumeService } from './resume-service'
import { waitpointRepo, waitpointSlotRepo } from './waitpoint-service'
import { Waitpoint, WaitpointResumePayload, WaitpointSlot, WaitpointSlotStatus, WaitpointStatus } from './waitpoint-types'

// A join waitpoint (#374) is answered once per slot and resumes its run exactly once, when the
// failure policy decides. Every write takes the waitpoint row FOR UPDATE, so two answers landing
// together are counted one after the other, and the one that decides is the only one that completes.
export const joinWaitpointService = (log: FastifyBaseLogger) => ({
    async fillSlot({ flowRunId, projectId, waitpointId, slotId, answer, childRunId, onlyForClaimant = false }: FillSlotParams): Promise<FillSlotResult> {
        const decision = await transaction(async (entityManager) => {
            const waitpoint = await lockPendingJoin({ entityManager, flowRunId, waitpointId })
            // A server-side caller knows the project and gets it enforced; an HTTP answer knows only
            // ids, and its slot id is the credential.
            if (isNil(waitpoint) || isNil(waitpoint.join) || (!isNil(projectId) && waitpoint.projectId !== projectId)) {
                return { accepted: false, completed: null }
            }
            // First answer wins: a duplicate callback, or a child's terminal status arriving after its
            // own Return Response, changes nothing.
            const updated = await waitpointSlotRepo(entityManager).update(
                { id: slotId, waitpointId: waitpoint.id, projectId: waitpoint.projectId, status: WaitpointSlotStatus.PENDING, ...(onlyForClaimant ? { childRunId } : {}) },
                { status: answer.status, payload: capSlotData(answer.data), ...spreadIfDefined('childRunId', childRunId) },
            )
            if ((updated.affected ?? 0) === 0) {
                return { accepted: false, completed: null }
            }
            const completed = await completeIfDecided({ entityManager, waitpoint, join: waitpoint.join, expired: false })
            return { accepted: true, completed }
        })
        if (!decision.accepted) {
            log.info({ flowRunId, waitpointId }, '[joinWaitpointService#fillSlot] No pending slot matches; dropping the answer')
            return { accepted: false }
        }
        if (!isNil(decision.completed)) {
            await resumeCompletedJoin({ log, waitpoint: decision.completed })
        }
        return { accepted: true }
    },

    // A child that ended without answering its slot — it failed, was stopped, timed out, or simply
    // never reached a Return Response — still owes its parent an answer, or the join waits forever.
    async fillSlotForFinishedChild({ childRun }: FillSlotForFinishedChildParams): Promise<void> {
        const { parentRunId, parentWaitpointId, parentSlotId } = childRun
        if (isNil(parentRunId) || isNil(parentWaitpointId) || isNil(parentSlotId)) {
            return
        }
        const answer: SlotAnswer = childRun.status === FlowRunStatus.SUCCEEDED
            ? { status: WaitpointSlotStatus.SUCCEEDED, data: null }
            : {
                status: WaitpointSlotStatus.FAILED,
                data: {
                    message: 'Subflow execution failed',
                    status: childRun.status,
                    link: await domainHelper.getPublicUrl({ path: `/projects/${childRun.projectId}/runs/${childRun.id}` }),
                },
            }
        // Only the child the slot was claimed for may answer it by finishing.
        await this.fillSlot({ flowRunId: parentRunId, projectId: childRun.projectId, waitpointId: parentWaitpointId, slotId: parentSlotId, answer, childRunId: childRun.id, onlyForClaimant: true })
    },

    async expire({ flowRunId, projectId, waitpointId }: ExpireParams): Promise<void> {
        const completed = await transaction(async (entityManager) => {
            const waitpoint = await lockPendingJoin({ entityManager, flowRunId, waitpointId })
            if (isNil(waitpoint) || isNil(waitpoint.join) || waitpoint.projectId !== projectId) {
                return null
            }
            return completeIfDecided({ entityManager, waitpoint, join: waitpoint.join, expired: true })
        })
        if (isNil(completed)) {
            log.info({ flowRunId, waitpointId }, '[joinWaitpointService#expire] Join already decided; nothing to expire')
            return
        }
        log.info({ flowRunId, waitpointId }, '[joinWaitpointService#expire] Join timed out; resuming with the answers that arrived')
        await resumeCompletedJoin({ log, waitpoint: completed })
    },
})

export const joinPolicy = {
    // Decides from the per-status counts alone, so an answer never has to read the other answers;
    // `expired` treats every unanswered slot as timed out.
    decide({ join, counts, expired }: DecideParams): JoinDecision {
        const timedOut = counts.timedOut + (expired ? counts.pending : 0)
        const unanswered = expired ? 0 : counts.pending
        const outcome = decideOutcome({ join, total: counts.total, succeeded: counts.succeeded, failed: counts.failed + timedOut, unanswered })
        return isNil(outcome) ? { done: false } : { done: true, status: outcome }
    },
    // The aggregate the run resumes with, in slot order; built once, when the join completes.
    buildResult({ slots, expired }: BuildResultParams): JoinResult {
        const ordered = [...slots].sort((a, b) => a.slotIndex - b.slotIndex)
        const results = ordered.map((slot) => toSlotResult({ slot, expired }))
        return {
            results,
            succeeded: results.filter((result) => result.status === 'success').length,
            failed: results.filter((result) => result.status === 'error').length,
            timedOut: results.filter((result) => result.status === 'timeout').length,
        }
    },
}

function decideOutcome({ join, total, succeeded, failed, unanswered }: DecideOutcomeParams): 'success' | 'error' | undefined {
    switch (join.failurePolicy) {
        case JoinFailurePolicy.enum.ALL_SETTLED:
            return unanswered === 0 ? 'success' : undefined
        case JoinFailurePolicy.enum.FAIL_FAST:
            if (failed > 0) {
                return 'error'
            }
            return unanswered === 0 ? 'success' : undefined
        case JoinFailurePolicy.enum.QUORUM: {
            const quorum = join.quorum ?? total
            if (succeeded >= quorum) {
                return 'success'
            }
            // Even if every unanswered slot succeeded, the quorum is out of reach.
            if (succeeded + unanswered < quorum) {
                return 'error'
            }
            return undefined
        }
        default:
            return undefined
    }
}

function toSlotResult({ slot, expired }: { slot: WaitpointSlot, expired: boolean }): JoinSlotResult {
    switch (slot.status) {
        case WaitpointSlotStatus.SUCCEEDED:
            return { status: 'success', data: readSlotData(slot.payload) }
        case WaitpointSlotStatus.FAILED:
            return { status: 'error', data: readSlotData(slot.payload) }
        case WaitpointSlotStatus.TIMED_OUT:
            return { status: 'timeout', data: null }
        case WaitpointSlotStatus.PENDING:
            return { status: expired ? 'timeout' : 'pending', data: null }
    }
}

async function lockPendingJoin({ entityManager, flowRunId, waitpointId }: LockPendingJoinParams): Promise<Waitpoint | null> {
    return waitpointRepo(entityManager)
        .createQueryBuilder('waitpoint')
        .setLock('pessimistic_write')
        .where({ id: waitpointId, flowRunId, status: WaitpointStatus.PENDING, join: Not(IsNull()) })
        .getOne()
}

async function completeIfDecided({ entityManager, waitpoint, join, expired }: CompleteIfDecidedParams): Promise<Waitpoint | null> {
    const counts = await countSlots({ entityManager, waitpoint })
    const decision = joinPolicy.decide({ join, counts, expired })
    if (!decision.done) {
        return null
    }
    if (expired) {
        await waitpointSlotRepo(entityManager).update(
            { waitpointId: waitpoint.id, projectId: waitpoint.projectId, status: WaitpointSlotStatus.PENDING },
            { status: WaitpointSlotStatus.TIMED_OUT },
        )
    }
    // The only read of the answers themselves: up to 500 of them, each up to 64 KB, once per join.
    const slots = await waitpointSlotRepo(entityManager).findBy({ waitpointId: waitpoint.id, projectId: waitpoint.projectId })
    const body = { status: decision.status, data: joinPolicy.buildResult({ slots, expired }) }
    const resumePayload: WaitpointResumePayload = { body, headers: {}, queryParams: {} }
    const completed: Waitpoint = { ...waitpoint, status: WaitpointStatus.COMPLETED, resumePayload }
    await waitpointRepo(entityManager).save(completed)
    return completed
}

async function countSlots({ entityManager, waitpoint }: { entityManager: EntityManager, waitpoint: Waitpoint }): Promise<SlotCounts> {
    const rows: { status: string, count: string }[] = await waitpointSlotRepo(entityManager)
        .createQueryBuilder('slot')
        .select('slot.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where({ waitpointId: waitpoint.id, projectId: waitpoint.projectId })
        .groupBy('slot.status')
        .getRawMany()
    const countOf = (status: WaitpointSlotStatus): number => Number(rows.find((row) => row.status === status)?.count ?? 0)
    const counts = {
        succeeded: countOf(WaitpointSlotStatus.SUCCEEDED),
        failed: countOf(WaitpointSlotStatus.FAILED),
        timedOut: countOf(WaitpointSlotStatus.TIMED_OUT),
        pending: countOf(WaitpointSlotStatus.PENDING),
    }
    return { ...counts, total: counts.succeeded + counts.failed + counts.timedOut + counts.pending }
}

// The run may already be PAUSED (resume now) or still RUNNING (the waitpoint is COMPLETED, and the
// PAUSED upload resumes it); `handleResumeSignal` tells the two apart, as for any other waitpoint.
async function resumeCompletedJoin({ log, waitpoint }: { log: FastifyBaseLogger, waitpoint: Waitpoint }): Promise<void> {
    await resumeService(log).resumeFromWaitpoint({
        flowRunId: waitpoint.flowRunId,
        projectId: waitpoint.projectId,
        waitpointId: waitpoint.id,
        resumePayload: waitpoint.resumePayload,
    })
}

// A slot's answer comes from a child's own flow, and 500 of them resume one run: each is capped so
// the aggregate stays bounded.
function capSlotData(data: unknown): string {
    const serialized = JSON.stringify(sanitizeObjectForPostgresql(data ?? null)) ?? 'null'
    const sizeBytes = Buffer.byteLength(serialized, 'utf8')
    if (sizeBytes > JOIN_SLOT_MAX_DATA_BYTES) {
        return JSON.stringify({ truncated: true, sizeBytes, maxBytes: JOIN_SLOT_MAX_DATA_BYTES })
    }
    return serialized
}

function readSlotData(payload: string | null): unknown {
    return isNil(payload) ? null : JSON.parse(payload)
}

type SlotAnswer = {
    status: WaitpointSlotStatus.SUCCEEDED | WaitpointSlotStatus.FAILED
    data: unknown
}

type FillSlotParams = {
    flowRunId: string
    projectId?: string
    waitpointId: string
    slotId: string
    answer: SlotAnswer
    childRunId?: string
    onlyForClaimant?: boolean
}

type FillSlotResult = {
    accepted: boolean
}

type FillSlotForFinishedChildParams = {
    childRun: {
        id: string
        projectId: string
        status: FlowRunStatus
        parentRunId?: string
        parentWaitpointId?: string
        parentSlotId?: string
    }
}

type ExpireParams = {
    flowRunId: string
    projectId: string
    waitpointId: string
}

type DecideParams = {
    join: JoinWaitpointConfig
    counts: SlotCounts
    expired: boolean
}

type BuildResultParams = {
    slots: WaitpointSlot[]
    expired: boolean
}

type SlotCounts = {
    succeeded: number
    failed: number
    timedOut: number
    pending: number
    total: number
}

type DecideOutcomeParams = {
    join: JoinWaitpointConfig
    total: number
    succeeded: number
    failed: number
    unanswered: number
}

type JoinDecision =
    | { done: false }
    | { done: true, status: 'success' | 'error' }

type LockPendingJoinParams = {
    entityManager: EntityManager
    flowRunId: string
    waitpointId: string
}

type CompleteIfDecidedParams = {
    entityManager: EntityManager
    waitpoint: Waitpoint
    join: JoinWaitpointConfig
    expired: boolean
}

export type { SlotAnswer }

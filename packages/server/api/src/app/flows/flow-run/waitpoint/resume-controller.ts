import {
    ALL_PRINCIPAL_TYPES,
    apId,
    ApId,
    ErrorCode,
    QadamFlowError,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyReply } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { findFlowRunForLegacyResume, LegacyResumeFlowRun } from '../flow-run-service'
import { joinWaitpointService, SlotAnswer } from './join-waitpoint-service'
import { resumeService } from './resume-service'
import { waitpointService } from './waitpoint-service'
import { Waitpoint, WaitpointSlotStatus } from './waitpoint-types'

export const resumeController: FastifyPluginAsyncZod = async (app) => {
    app.all('/:id/waitpoints/:waitpointId', ResumeByWaitpointRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        if (await refusesJoinWaitpoint({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, log: req.log })) {
            await reply.send({ message: EXPIRED_LINK_MESSAGE })
            return
        }
        await handleAsyncResume({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, body: req.body, headers, queryParams, log: req.log, reply })
    })

    app.all('/:id/waitpoints/:waitpointId/sync', ResumeByWaitpointRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        // waitpointId is unique per waitpoint but NOT per request: a duplicate/retried request
        // (double-click, client retry, link-scanner prefetch) hitting the same waitpoint would
        // otherwise share this key with the original request and collide in
        // engineResponseWatcher's listener map. Mint a fresh id per request instead.
        if (await refusesJoinWaitpoint({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, log: req.log })) {
            await reply.status(StatusCodes.GONE).send({ message: EXPIRED_LINK_MESSAGE })
            return
        }
        await handleSyncResume({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
    })

    /**
     * One child's answer to a join waitpoint (#374). The slot id is the credential: every child of
     * the join sees the parent's run id and waitpoint id, but only its own slot id, so it can answer
     * only its own slot. A first answer wins; a later one, or one for a slot that is not pending on a
     * pending join, is reported as expired like any other stale resume link.
     */
    app.all('/:id/waitpoints/:waitpointId/slots/:slotId', ResumeBySlotRequest, async (req, reply) => {
        const { accepted } = await joinWaitpointService(req.log).fillSlot({
            flowRunId: req.params.id,
            waitpointId: req.params.waitpointId,
            slotId: req.params.slotId,
            answer: toSlotAnswer(req.body),
        })
        await reply.send({ message: accepted ? RECORDED_MESSAGE : EXPIRED_LINK_MESSAGE })
    })

    /**
     * @deprecated Legacy resume route for V0 waitpoints created by pieces still on the pre-shim
     * `run.pause()` + `generateResumeUrl()` API. flowRunId (an unguessable apId) is this route's
     * only credential — requestId is never validated.
     *
     * If a PENDING V0 waitpoint exists for the run, this resumes through the same path the V1
     * waitpoint routes use. Otherwise it falls through to the no-waitpoint legacy branch
     * (resumeService#legacyResume), which requires ALL of: the run is PAUSED; its pauseMetadata
     * parses as a pre-shim WEBHOOK pause; and the run has NO waitpoint row at all, of any status
     * or version — see resumeService#isEligibleForLegacyNoWaitpointResume. That third condition
     * is what stops this route from being used to resume a run's later, unrelated PENDING
     * waitpoint (V0 or V1) by anyone who only holds an earlier approval link for the same run —
     * every resume URL, V0 or V1, embeds the run id, so an earlier link is enough to reach this
     * route for the run's current pause too.
     *
     * Removable once no PAUSED run can predate the piece-API pause shim (buildLegacyPauseHook,
     * deployed 2026-04-13), which is the point every `run.pause()` call started creating a real
     * waitpoint row itself (and process.exit(1)-ing if that write failed) — so only a run paused
     * by a pre-shim engine can still reach this branch. That is bounded by this platform's
     * configured execution-data retention: FILE_CLEANUP_TRIGGER purges FLOW_RUN_LOG files past
     * AP_EXECUTION_DATA_RETENTION_DAYS, and PAUSED_FLOW_TIMEOUT_DAYS is capped at that same
     * retention (system-validator.ts), so a pre-shim paused run cannot outlive it. Safe removal
     * date = shim deploy date (2026-04-13) + this deployment's configured retention (30 days by
     * default) — later if any deployment raised retention above the default.
     */
    app.all('/:id/requests/:requestId', V0ResumeFlowRunRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        const flowRun = await resolveV0FlowRun({ flowRunId: req.params.id, log: req.log })
        if (!flowRun) {
            await reply.send({ message: 'This link has expired. The action may have already been processed.' })
            return
        }
        const waitpoint = await findPendingV0Waitpoint({ flowRun, log: req.log })
        if (waitpoint) {
            await handleAsyncResume({ flowRunId: flowRun.id, waitpointId: waitpoint.id, body: req.body, headers, queryParams, log: req.log, reply })
        }
        else {
            await handleLegacyAsyncResume({ flowRun, body: req.body, headers, queryParams, log: req.log, reply })
        }
    })

    /**
     * @deprecated See the sibling `/:id/requests/:requestId` route above — same eligibility rules
     * and same removal condition, just the synchronous variant (410 GONE instead of a 200
     * "expired" body for a stale/ineligible resume).
     */
    app.all('/:id/requests/:requestId/sync', V0ResumeFlowRunRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        const flowRun = await resolveV0FlowRun({ flowRunId: req.params.id, log: req.log })
        if (!flowRun) {
            await reply.status(StatusCodes.GONE).send({ message: 'This link has expired. The action may have already been processed.' })
            return
        }
        const waitpoint = await findPendingV0Waitpoint({ flowRun, log: req.log })
        // Each sync resume needs its own key into engineResponseWatcher's process-wide listener
        // map. waitpoint.workerHandlerId is the SERVER_ID shared by every V0 waitpoint on this
        // server, and req.params.requestId is caller-chosen and unvalidated (see this route's
        // own JSDoc above) — either one used as the key lets two concurrent callers collide and
        // receive each other's response. Mint a fresh id per request instead, the way the
        // non-V0 waitpoint route above does.
        if (waitpoint) {
            await handleSyncResume({ flowRunId: flowRun.id, waitpointId: waitpoint.id, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
        }
        else {
            await handleLegacySyncResume({ flowRun, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
        }
    })
}

async function handleAsyncResume({ flowRunId, waitpointId, body, headers, queryParams, log, reply }: AsyncResumeHandlerParams): Promise<void> {
    const { stale } = await resumeService(log).resumeFromWaitpoint({
        flowRunId,
        waitpointId,
        resumePayload: { body, headers, queryParams },
    })
    if (stale) {
        await reply.send({ message: 'This link has expired. The action may have already been processed.' })
        return
    }
    await reply.send({ message: 'Your response has been recorded. You can close this page now.' })
}

async function handleSyncResume({ flowRunId, waitpointId, body, headers, queryParams, log, reply, correlationId }: AsyncResumeHandlerParams & { correlationId: string }): Promise<void> {
    const response = await resumeService(log).handleSyncResumeFlow({
        runId: flowRunId,
        waitpointId,
        payload: { body, headers, queryParams },
        correlationId,
    })
    await reply.status(response.status).headers(response.headers).send(response.body)
}

async function handleLegacyAsyncResume({ flowRun, body, headers, queryParams, log, reply }: LegacyResumeHandlerParams): Promise<void> {
    const { stale } = await resumeService(log).legacyResume({
        flowRun,
        resumePayload: { body, headers, queryParams },
    })
    if (stale) {
        await reply.send({ message: 'This link has expired. The action may have already been processed.' })
        return
    }
    await reply.send({ message: 'Your response has been recorded. You can close this page now.' })
}

async function handleLegacySyncResume({ flowRun, body, headers, queryParams, log, reply, correlationId }: LegacyResumeHandlerParams & { correlationId: string }): Promise<void> {
    const response = await resumeService(log).legacySyncResume({
        flowRun,
        payload: { body, headers, queryParams },
        correlationId,
    })
    await reply.status(response.status).headers(response.headers).send(response.body)
}

/**
 * Resolves the run exactly ONCE for both V0 legacy routes, before either branch (has a PENDING
 * V0 waitpoint / no-waitpoint legacy fallback) is chosen. Previously this controller resolved the
 * run once to look up a PENDING V0 waitpoint, then legacyResume/legacySyncResume resolved it
 * *again* if none was found — leaving a window between the two reads where the #509
 * runsMetadataQueue drain lag (or a legitimate concurrent waitpoint creation) could land a row
 * that the first read missed, letting the no-waitpoint legacy branch resume a run that by the
 * second read already had a real waitpoint. A single resolve-and-pass-down closes that window.
 *
 * A run that no longer exists is not an error here: both V0 routes reply "stale" directly, the
 * same tolerance resumeFromWaitpoint already applies on the non-legacy waitpoint routes, for the
 * same drain-lag reason — a resume can legitimately arrive after its own run's row is gone.
 */
async function resolveV0FlowRun({ flowRunId, log }: ResolveV0FlowRunParams): Promise<LegacyResumeFlowRun | null> {
    const { data: flowRun, error: notFoundError } = await tryCatch(() => findFlowRunForLegacyResume({ flowRunId }))
    if (notFoundError) {
        if (notFoundError instanceof QadamFlowError && notFoundError.error.code === ErrorCode.ENTITY_NOT_FOUND) {
            log.info({ flowRunId }, '[resumeController#resolveV0FlowRun] Flow run not found, treating resume as stale')
            return null
        }
        throw notFoundError
    }
    return flowRun
}

async function findPendingV0Waitpoint({ flowRun, log }: FindPendingV0WaitpointParams): Promise<Waitpoint | null> {
    return waitpointService(log).findPendingByVersion({ flowRunId: flowRun.id, projectId: flowRun.projectId, version: 'V0' })
}

// A join waitpoint resumes only through its slots and resumes once, with the aggregate: a plain
// resume would let any child, which knows the waitpoint id from its own callback URL, answer for all.
async function refusesJoinWaitpoint({ flowRunId, waitpointId, log }: RefusesJoinWaitpointParams): Promise<boolean> {
    const isJoin = await waitpointService(log).isJoinWaitpoint({ id: waitpointId, flowRunId })
    if (isJoin) {
        log.info({ flowRunId, waitpointId }, '[resumeController] Refused a plain resume of a join waitpoint')
    }
    return isJoin
}

// The shape `returnResponse` posts to its callback. Anything else posted to a slot is taken as a
// successful answer carrying that body, as a plain waitpoint would take it.
function toSlotAnswer(body: unknown): SlotAnswer {
    const parsed = SlotCallbackBody.safeParse(body)
    if (!parsed.success) {
        return { status: WaitpointSlotStatus.SUCCEEDED, data: body ?? null }
    }
    return {
        status: parsed.data.status === 'error' ? WaitpointSlotStatus.FAILED : WaitpointSlotStatus.SUCCEEDED,
        data: parsed.data.data ?? null,
    }
}

const EXPIRED_LINK_MESSAGE = 'This link has expired. The action may have already been processed.'
const RECORDED_MESSAGE = 'Your response has been recorded. You can close this page now.'

const SlotCallbackBody = z.object({
    status: z.enum(['success', 'error']),
    data: z.unknown(),
})

const ResumeBySlotRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: z.object({
            id: ApId,
            waitpointId: ApId,
            slotId: ApId,
        }),
    },
}

const ResumeByWaitpointRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: z.object({
            id: ApId,
            waitpointId: z.string(),
        }),
    },
}

const V0ResumeFlowRunRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: z.object({
            id: ApId,
            requestId: z.string(),
        }),
    },
}

type AsyncResumeHandlerParams = {
    flowRunId: string
    waitpointId: string
    body: unknown
    headers: Record<string, string>
    queryParams: Record<string, string>
    log: FastifyBaseLogger
    reply: FastifyReply
}

type LegacyResumeHandlerParams = {
    flowRun: LegacyResumeFlowRun
    body: unknown
    headers: Record<string, string>
    queryParams: Record<string, string>
    log: FastifyBaseLogger
    reply: FastifyReply
}

type RefusesJoinWaitpointParams = {
    flowRunId: string
    waitpointId: string
    log: FastifyBaseLogger
}

type ResolveV0FlowRunParams = {
    flowRunId: string
    log: FastifyBaseLogger
}

type FindPendingV0WaitpointParams = {
    flowRun: LegacyResumeFlowRun
    log: FastifyBaseLogger
}

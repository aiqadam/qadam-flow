import {
    ALL_PRINCIPAL_TYPES,
    apId,
    ApId,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyReply } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { resumeService } from './resume-service'
import { waitpointService } from './waitpoint-service'

export const resumeController: FastifyPluginAsyncZod = async (app) => {
    app.all('/:id/waitpoints/:waitpointId', ResumeByWaitpointRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        await handleAsyncResume({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, body: req.body, headers, queryParams, log: req.log, reply })
    })

    app.all('/:id/waitpoints/:waitpointId/sync', ResumeByWaitpointRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        // waitpointId is unique per waitpoint but NOT per request: a duplicate/retried request
        // (double-click, client retry, link-scanner prefetch) hitting the same waitpoint would
        // otherwise share this key with the original request and collide in
        // engineResponseWatcher's listener map. Mint a fresh id per request instead.
        await handleSyncResume({ flowRunId: req.params.id, waitpointId: req.params.waitpointId, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
    })

    /**
     * @deprecated Deprecated since 2026-04-13. can be only removed after all paused jobs after deployment of this version to sink.
     * Handles resume for V0 waitpoints created by legacy pieces using run.pause() + generateResumeUrl().
     * The requestId param is NOT validated — flowRunId (an unguessable apId) provides access control.
     */
    app.all('/:id/requests/:requestId', V0ResumeFlowRunRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        const waitpoint = await waitpointService(req.log).findPendingByVersion({ flowRunId: req.params.id, version: 'V0' })
        if (waitpoint) {
            await handleAsyncResume({ flowRunId: req.params.id, waitpointId: waitpoint.id, body: req.body, headers, queryParams, log: req.log, reply })
        }
        else {
            await handleLegacyAsyncResume({ flowRunId: req.params.id, body: req.body, headers, queryParams, log: req.log, reply })
        }
    })

    /**
     * @deprecated Deprecated since 2026-04-13. can be only removed after all paused jobs after deployment of this version to sink.
     */
    app.all('/:id/requests/:requestId/sync', V0ResumeFlowRunRequest, async (req, reply) => {
        const headers = req.headers as Record<string, string>
        const queryParams = req.query as Record<string, string>
        const waitpoint = await waitpointService(req.log).findPendingByVersion({ flowRunId: req.params.id, version: 'V0' })
        // Each sync resume needs its own key into engineResponseWatcher's process-wide listener
        // map. waitpoint.workerHandlerId is the SERVER_ID shared by every V0 waitpoint on this
        // server, and req.params.requestId is caller-chosen and unvalidated (see this route's
        // own JSDoc above) — either one used as the key lets two concurrent callers collide and
        // receive each other's response. Mint a fresh id per request instead, the way the
        // non-V0 waitpoint route above does.
        if (waitpoint) {
            await handleSyncResume({ flowRunId: req.params.id, waitpointId: waitpoint.id, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
        }
        else {
            await handleLegacySyncResume({ flowRunId: req.params.id, body: req.body, headers, queryParams, log: req.log, reply, correlationId: apId() })
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

async function handleLegacyAsyncResume({ flowRunId, body, headers, queryParams, log, reply }: LegacyResumeHandlerParams): Promise<void> {
    const { stale } = await resumeService(log).legacyResume({
        flowRunId,
        resumePayload: { body, headers, queryParams },
    })
    if (stale) {
        await reply.send({ message: 'This link has expired. The action may have already been processed.' })
        return
    }
    await reply.send({ message: 'Your response has been recorded. You can close this page now.' })
}

async function handleLegacySyncResume({ flowRunId, body, headers, queryParams, log, reply, correlationId }: LegacyResumeHandlerParams & { correlationId: string }): Promise<void> {
    const response = await resumeService(log).legacySyncResume({
        runId: flowRunId,
        payload: { body, headers, queryParams },
        correlationId,
    })
    await reply.status(response.status).headers(response.headers).send(response.body)
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
    flowRunId: string
    body: unknown
    headers: Record<string, string>
    queryParams: Record<string, string>
    log: FastifyBaseLogger
    reply: FastifyReply
}

import { CreateWaitpointRequest, CreateWaitpointResponse } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { domainHelper } from '../../../helper/domain-helper'
import { waitpointService } from './waitpoint-service'

export const waitpointController: FastifyPluginAsyncZod = async (app) => {
    app.post('/', CreateWaitpointParams, async (request, reply) => {
        const { flowRunId, projectId, stepName, type, version, resumeDateTime, responseToSend, workerHandlerId, httpRequestId, internal } = request.body
        const { waitpoint } = await waitpointService(request.log).createForPause({
            flowRunId,
            projectId,
            stepName,
            type,
            version,
            resumeDateTime,
            responseToSend: responseToSend ?? undefined,
            workerHandlerId: workerHandlerId ?? undefined,
            httpRequestId: httpRequestId ?? undefined,
        })
        // An internal-only waitpoint (resumed exclusively by this same server
        // instance POSTing to itself, e.g. callFlow's queue-mode wait-for-
        // response) needs a URL this instance can actually reach itself on —
        // AP_FRONTEND_URL/AP_WEBHOOK_URL is deliberately the externally
        // reachable address (what a browser or a real external webhook
        // sender uses), which is not necessarily the same address as seen
        // from inside the deployment (e.g. a docker-compose port mapping
        // publishes a different port externally than the container listens
        // on internally).
        const resumeUrlPath = { path: `v1/flow-runs/${flowRunId}/waitpoints/${waitpoint.id}` }
        const resumeUrl = internal
            ? await domainHelper.getSelfApiUrl(resumeUrlPath)
            : await domainHelper.getPublicApiUrl(resumeUrlPath)
        return reply.status(StatusCodes.CREATED).send({
            id: waitpoint.id,
            resumeUrl,
        })
    })
}

const CreateWaitpointParams = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        body: CreateWaitpointRequest,
        response: {
            [StatusCodes.CREATED]: CreateWaitpointResponse,
        },
    },
}

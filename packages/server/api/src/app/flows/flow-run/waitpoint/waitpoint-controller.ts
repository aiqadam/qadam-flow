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
        // An internal-only waitpoint (resumed exclusively by a POST from
        // inside this same deployment, e.g. callFlow's queue-mode wait-for-
        // response — the child flow's Return Response step, which can run in
        // a *different* container than the one that created this waitpoint,
        // e.g. a worker container in the bundled docker-compose deployment)
        // needs a URL any process in the deployment can reach the app on —
        // AP_FRONTEND_URL/AP_WEBHOOK_URL is deliberately the externally
        // reachable address (what a browser or a real external webhook
        // sender uses), which a sibling container cannot necessarily reach
        // (e.g. a docker-compose port mapping publishes a different port
        // externally than the app container listens on internally, and a
        // worker container has no route to that published port at all).
        // getInternalApiUrl (AppSystemProp.INTERNAL_URL, e.g. AP_INTERNAL_URL
        // =http://app:80 set by run.sh) is exactly the address other
        // containers in the same deployment already use to reach the app.
        const resumeUrlPath = { path: `v1/flow-runs/${flowRunId}/waitpoints/${waitpoint.id}` }
        const resumeUrl = internal
            ? await domainHelper.getInternalApiUrl(resumeUrlPath)
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

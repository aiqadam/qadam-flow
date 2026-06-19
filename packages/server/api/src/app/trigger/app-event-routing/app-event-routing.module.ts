import { facebookLeads } from '@aiqadam/qadam-facebook-leads'
import { intercom } from '@aiqadam/qadam-intercom'
import { slack } from '@aiqadam/qadam-slack'
import { Qadam, QadamAuthProperty } from '@aiqadam/qadams-framework'
import {
    apId,
    assertNotNullOrUndefined,
    ErrorCode,
    FlowStatus,
    isNil,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    QadamFlowError,
    RunEnvironment,
    WorkerJobType,
} from '@aiqadam/shared'
import { FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { flowService } from '../../flows/flow/flow.service'
import { domainHelper } from '../../helper/domain-helper'
import { rejectedPromiseHandler } from '../../helper/promise-handler'
import { projectService } from '../../project/project-service'
import { WebhookFlowVersionToRun, webhookService } from '../../webhooks/webhook.service'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { payloadOffloader } from '../../workers/payload-offloader'
import { triggerSourceService } from '../trigger-source/trigger-source-service'
import { appEventRoutingService } from './app-event-routing.service'

const appWebhooks: Record<string, Qadam<QadamAuthProperty | QadamAuthProperty[] | undefined>> = {
    slack,
    'facebook-leads': facebookLeads,
    intercom,
}
const qadamNames: Record<string, string> = {
    slack: '@aiqadam/qadam-slack',
    'facebook-leads': '@aiqadam/qadam-facebook-leads',
    intercom: '@aiqadam/qadam-intercom',
}

export const appEventRoutingModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(appEventRoutingController, { prefix: '/v1/app-events' })
}

export const appEventRoutingController: FastifyPluginAsyncZod = async (
    fastify,
) => {
    fastify.all(
        '/:pieceUrl',
        {
            config: {
                rawBody: true,
                security: securityAccess.public(),
            },
        },
        async (
            request: FastifyRequest<{
                Body: unknown
                Params: {
                    pieceUrl: string
                }
            }>,
            requestReply,
        ) => {
            const pieceUrl = request.params.pieceUrl
            const payload = {
                headers: request.headers as Record<string, string>,
                body: request.body,
                rawBody: request.rawBody,
                method: request.method,
                queryParams: request.query as Record<string, string>,
            }
            const qadam = appWebhooks[pieceUrl]
            if (isNil(qadam)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        entityType: 'qadam',
                        entityId: pieceUrl,
                        message: 'Qadam is not found in app event routing',
                    },
                })
            }
            const appName = qadamNames[pieceUrl]
            assertNotNullOrUndefined(qadam.events, 'Event is possible in this qadam')
            const { reply, event, identifierValue } = qadam.events.parseAndReply({
                payload,
                server: {
                    publicUrl: await domainHelper.getPublicUrl({ path: '' }),
                },
            })
            if (!isNil(reply)) {
                request.log.info(
                    {
                        reply,
                        qadam: pieceUrl,
                    },
                    '[AppEventRoutingController#event] reply',
                )
                return requestReply
                    .status(StatusCodes.OK)
                    .headers(reply?.headers ?? {})
                    .send(reply?.body ?? {})
            }
            request.log.info(
                {
                    event,
                    identifierValue,
                },
                '[AppEventRoutingController#event] event',
            )
            if (isNil(event) || isNil(identifierValue)) {
                return requestReply.status(StatusCodes.BAD_REQUEST).send({})
            }
            const listeners = await appEventRoutingService.listListeners({
                appName,
                event,
                identifierValue,
            })
            const eventsQueue = listeners.map(async (listener) => {
                const requestId = apId()
                const flow = await flowService(request.log).getOne({ id: listener.flowId, projectId: listener.projectId })
                if (isNil(flow)) {
                    return
                }
                const isSimulating = await triggerSourceService(request.log).existsByFlowId({
                    flowId: listener.flowId,
                    simulate: true,
                })
                const flowVersionIdToRun = await webhookService.getFlowVersionIdToRun(
                    isSimulating ? WebhookFlowVersionToRun.LATEST : WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
                    flow,
                )
                const platformId = await projectService(request.log).getPlatformId(listener.projectId)
                const jobPayload = await payloadOffloader.offloadPayload(request.log, payload, listener.projectId, platformId)
                return jobQueue(request.log).add({
                    id: requestId,
                    type: JobType.ONE_TIME,
                    data: {
                        platformId,
                        projectId: listener.projectId,
                        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                        requestId,
                        payload: jobPayload,
                        flowId: listener.flowId,
                        jobType: WorkerJobType.EXECUTE_WEBHOOK,
                        runEnvironment: isSimulating ? RunEnvironment.TESTING : RunEnvironment.PRODUCTION,
                        saveSampleData: isSimulating,
                        flowVersionIdToRun,
                        execute: flow.status === FlowStatus.ENABLED,
                    },
                })
            })
            rejectedPromiseHandler(Promise.all(eventsQueue), request.log)
            return requestReply.status(StatusCodes.OK).send({})
        },
    )
}

import { apId, assertNotNullOrUndefined, EngineHttpResponse, EventPayload, ExecutionType, Flow, FlowRun, FlowStatus, FlowVersionId, isNil, LATEST_JOB_DATA_SCHEMA_VERSION, PlatformId, ProjectId, RunEnvironment, StreamStepProgress, TriggerPayload, tryCatch, WorkerJobType } from '@aiqadam/shared'
import { context, propagation, trace } from '@opentelemetry/api'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { flowExecutionCache } from '../flows/flow/flow-execution-cache'
import { flowRunService, SYNC_RUN_TIMEOUT_RESPONSE } from '../flows/flow-run/flow-run-service'
import { waitpointService } from '../flows/flow-run/waitpoint/waitpoint-service'
import { flowVersionRepo } from '../flows/flow-version/flow-version.service'
import { pinoLogging } from '../helper/logger'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { triggerSourceService } from '../trigger/trigger-source/trigger-source-service'
import { engineResponseWatcher } from '../workers/engine-response-watcher'
import { jobQueue, JobType } from '../workers/job-queue/job-queue'
import { payloadOffloader } from '../workers/payload-offloader'
import { webhookBackpressureService } from './webhook-backpressure-service'
import { webhookHandshake } from './webhook-handshake'

const tracer = trace.getTracer('webhook-service')
const WEBHOOK_TIMEOUT_MS = system.getNumberOrThrow(AppSystemProp.WEBHOOK_TIMEOUT_SECONDS) * 1000
const MAX_PAYLOAD_SIZE_BYTES = system.getNumberOrThrow(AppSystemProp.MAX_WEBHOOK_PAYLOAD_SIZE_MB) * 1024 * 1024

export enum WebhookFlowVersionToRun {
    LOCKED_FALL_BACK_TO_LATEST = 'locked_fall_back_to_latest',
    LATEST = 'latest',
}

export const webhookService = {
    async getFlowVersionIdToRun(type: WebhookFlowVersionToRun, flow: Flow): Promise<FlowVersionId> {
        if (type === WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST && !isNil(flow.publishedVersionId)) {
            return flow.publishedVersionId
        }

        const flowVersionSchema = await flowVersionRepo().createQueryBuilder()
            .select('id')
            .where({
                flowId: flow.id,
            })
            .orderBy('created', 'DESC')
            .getRawOne()
        assertNotNullOrUndefined(flowVersionSchema, 'Flow version not found')
        return flowVersionSchema.id
    },

    async handleWebhook({
        logger,
        data,
        flowId,
        async,
        saveSampleData,
        flowVersionToRun,
        payload,
        execute,
        onRunCreated,
        parentRunId,
        failParentOnFailure,
        parentWaitpointId,
        parentSlotId,
        timeoutMs,
        inheritedRunLocale,
    }: HandleWebhookParams): Promise<EngineHttpResponse> {
        return tracer.startActiveSpan('webhook.service.handle', {
            attributes: {
                'webhook.flowId': flowId,
                'webhook.async': async,
                'webhook.saveSampleData': saveSampleData,
                'webhook.execute': execute,
            },
        }, async (span) => {
            try {
                const webhookHeader = 'x-webhook-id'
                const webhookRequestId = apId()
                span.setAttribute('webhook.requestId', webhookRequestId)
                const pinoLogger = pinoLogging.createWebhookContextLog({ log: logger, webhookId: webhookRequestId, flowId })
                const flowExecutionResult = await flowExecutionCache(pinoLogger).get({
                    flowId,
                    simulate: saveSampleData,
                })

                if (!flowExecutionResult.exists) {
                    pinoLogger.info('Flow not found, returning GONE')
                    span.setAttribute('webhook.flowFound', false)
                    return {
                        status: StatusCodes.GONE,
                        body: {},
                        headers: {
                            [webhookHeader]: webhookRequestId,
                        },
                    }
                }
                const { flow } = flowExecutionResult
                if (flow.status === FlowStatus.DISABLED && !saveSampleData) {
                    pinoLogger.warn({ flowId }, 'Webhook received for disabled flow')
                    span.setAttribute('webhook.triggerSourceFound', false)
                    return {
                        status: StatusCodes.NOT_FOUND,
                        body: {},
                        headers: {
                            [webhookHeader]: webhookRequestId,
                        },
                    }
                }

                span.setAttribute('webhook.flowFound', true)
                span.setAttribute('webhook.projectId', flow.projectId)
                const flowVersionIdToRun = await webhookService.getFlowVersionIdToRun(flowVersionToRun, flow)
                span.setAttribute('webhook.flowVersionId', flowVersionIdToRun)

                const response = await webhookHandshake.handleHandshakeRequest({
                    payload: (payload ?? await data(flow.projectId)) as TriggerPayload,
                    handshakeConfiguration: flowExecutionResult.handshakeConfiguration ?? null,
                    flowId: flow.id,
                    flowVersionId: flowVersionIdToRun,
                    projectId: flow.projectId,
                    logger: pinoLogger,
                })
                if (!isNil(response)) {
                    logger.info({
                        flowId: flow.id,
                        flowVersionId: flowVersionIdToRun,
                        webhookRequestId,
                    }, 'Handshake request completed')
                    span.setAttribute('webhook.handshake', true)
                    return {
                        status: response.status,
                        body: response.body,
                        headers: response.headers ?? {},
                    }
                }

                pinoLogger.info('Adding webhook job to queue')

                // `parentRunId` itself is verified for project ownership downstream, in
                // `flowRunService`'s `queueOrCreateInstantly` — safe to apply to every caller,
                // trusted or not, since a trusted caller's parentRunId already belongs to its own
                // project. `failParentOnFailure` needs a stronger proof here specifically: even a
                // same-project run id can be *guessed* by anyone who can call this project's own
                // webhooks, and failing it would complete and resume a stranger's paused run
                // (#521 impact item 3). Verifying once, centrally, before branching into
                // sync/async, means neither path has to repeat it.
                const { failParentOnFailure: verifiedFailParentOnFailure, parentWaitpointId: verifiedParentWaitpointId, parentSlotId: verifiedParentSlotId } = await resolveParentAttachment({
                    parentRunId,
                    failParentOnFailure,
                    parentWaitpointId,
                    parentSlotId,
                    projectId: flow.projectId,
                    logger: pinoLogger,
                })

                const resolvedPayload = payload ?? await data(flow.projectId)

                const payloadSize = payloadOffloader.getPayloadSizeInBytes(resolvedPayload)
                if (payloadSize > MAX_PAYLOAD_SIZE_BYTES) {
                    pinoLogger.warn({ payloadSize, maxPayloadSizeBytes: MAX_PAYLOAD_SIZE_BYTES }, 'Webhook payload too large')
                    span.setAttribute('webhook.payloadTooLarge', true)
                    return {
                        status: StatusCodes.REQUEST_TOO_LONG,
                        body: { message: 'Payload too large' },
                        headers: {
                            [webhookHeader]: webhookRequestId,
                        },
                    }
                }

                if (async) {
                    span.setAttribute('webhook.mode', 'async')
                    return await handleAsync({
                        flow,
                        saveSampleData,
                        platformId: flowExecutionResult.platformId,
                        flowVersionIdToRun,
                        payload: resolvedPayload,
                        logger: pinoLogger,
                        webhookRequestId,
                        runEnvironment: flowVersionToRun === WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST ? RunEnvironment.PRODUCTION : RunEnvironment.TESTING,
                        webhookHeader,
                        execute: flow.status === FlowStatus.ENABLED && execute,
                        parentRunId,
                        failParentOnFailure: verifiedFailParentOnFailure,
                        parentWaitpointId: verifiedParentWaitpointId,
                        parentSlotId: verifiedParentSlotId,
                        inheritedRunLocale,
                    })
                }


                span.setAttribute('webhook.mode', 'sync')
                const flowHttpResponse = await handleSync({
                    payload: resolvedPayload,
                    projectId: flow.projectId,
                    flow,
                    platformId: flowExecutionResult.platformId,
                    runEnvironment: flowVersionToRun === WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST ? RunEnvironment.PRODUCTION : RunEnvironment.TESTING,
                    logger: pinoLogger,
                    webhookRequestId,
                    workerHandlerId: engineResponseWatcher(pinoLogger).getServerId(),
                    flowVersionIdToRun,
                    saveSampleData,
                    flowVersionToRun,
                    onRunCreated,
                    parentRunId,
                    failParentOnFailure: verifiedFailParentOnFailure,
                    parentWaitpointId: verifiedParentWaitpointId,
                    parentSlotId: verifiedParentSlotId,
                    timeoutMs,
                    inheritedRunLocale,
                })
                return {
                    status: flowHttpResponse.status,
                    body: flowHttpResponse.body,
                    headers: {
                        ...flowHttpResponse.headers,
                        [webhookHeader]: webhookRequestId,
                    },
                }
            }
            finally {
                span.end()
            }
        })
    },
}

async function handleAsync(params: AsyncWebhookParams): Promise<EngineHttpResponse> {
    return tracer.startActiveSpan('webhook.handler.async', {
        attributes: {
            'webhook.flowId': params.flow.id,
            'webhook.requestId': params.webhookRequestId,
            'webhook.saveSampleData': params.saveSampleData,
            'webhook.execute': params.execute,
            'webhook.environment': params.runEnvironment,
        },
    }, async (span) => {
        try {
            const { flow, logger, webhookRequestId, payload, flowVersionIdToRun, webhookHeader, saveSampleData, execute, runEnvironment, parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId, platformId, inheritedRunLocale } = params

            span.setAttribute('webhook.platformId', platformId)

            // Inject trace context for propagation across queue boundary
            const traceContext: Record<string, string> = {}
            propagation.inject(context.active(), traceContext)

            const jobPayload = await payloadOffloader.offloadPayload(logger, payload, flow.projectId, platformId)

            await jobQueue(logger).add({
                id: webhookRequestId,
                type: JobType.ONE_TIME,
                data: {
                    platformId,
                    projectId: flow.projectId,
                    schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                    requestId: webhookRequestId,
                    payload: jobPayload,
                    jobType: WorkerJobType.EXECUTE_WEBHOOK,
                    flowId: flow.id,
                    saveSampleData,
                    flowVersionIdToRun,
                    runEnvironment,
                    execute,
                    parentRunId,
                    failParentOnFailure,
                    parentWaitpointId,
                    parentSlotId,
                    inheritedRunLocale,
                    traceContext,
                },
            })
            logger.info('Async webhook request completed')
            span.setAttribute('webhook.queuedSuccessfully', true)
            return {
                status: StatusCodes.OK,
                body: {},
                headers: {
                    [webhookHeader]: webhookRequestId,
                },
            }
        }
        finally {
            span.end()
        }
    })
}

async function handleSync(params: SyncWebhookParams): Promise<EngineHttpResponse> {
    return tracer.startActiveSpan('webhook.handler.sync', {
        attributes: {
            'webhook.flowId': params.flow.id,
            'webhook.requestId': params.webhookRequestId,
            'webhook.saveSampleData': params.saveSampleData,
            'webhook.environment': params.runEnvironment,
        },
    }, async (span) => {
        try {
            const { payload, projectId, flow, logger, webhookRequestId, workerHandlerId, flowVersionIdToRun, runEnvironment, saveSampleData, flowVersionToRun, parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId, platformId, timeoutMs, inheritedRunLocale } = params

            if (saveSampleData) {
                rejectedPromiseHandler(savePayload({
                    flow,
                    logger,
                    webhookRequestId,
                    payload,
                    platformId,
                    flowVersionIdToRun,
                    runEnvironment,
                    parentRunId,
                    failParentOnFailure,
                    parentWaitpointId,
                    parentSlotId,
                }), logger)
            }

            const disabledFlow = flow.status !== FlowStatus.ENABLED && flowVersionToRun === WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST

            if (disabledFlow) {
                span.setAttribute('webhook.flowDisabled', true)
                return {
                    status: StatusCodes.NOT_FOUND,
                    body: {},
                    headers: {},
                }
            }

            const capacity = await webhookBackpressureService(logger).checkCapacity()
            if (!capacity.ok) {
                span.setAttribute('webhook.backpressureRejected', true)
                return {
                    status: StatusCodes.SERVICE_UNAVAILABLE,
                    // Budget-neutral: this instance refuses the run before it is even created, so the
                    // message must hold regardless of the caller's own wait budget — the default
                    // AP_WEBHOOK_TIMEOUT_SECONDS for a plain sync webhook, or a longer override such as
                    // MCP's 5-minute budget.
                    body: { message: 'The instance is at capacity for synchronous webhook runs and this one would not start before its caller stops waiting. Retry after the given delay, or switch this webhook to async.' },
                    headers: { 'Retry-After': String(capacity.retryAfterSeconds) },
                }
            }

            // The same instant the sync listener below times out at — a run dequeued after this
            // has passed fails explicitly instead of executing for a caller that has already
            // stopped waiting (#510). Computed here, not inside `start()`, so it shares the exact
            // reference instant the listener's own timeout starts counting from.
            const syncDeadline = new Date(Date.now() + (timeoutMs ?? WEBHOOK_TIMEOUT_MS)).toISOString()

            // Register the listener before starting the run: the engine can answer as soon as
            // the run is created, and if that happens before the listener is registered, the
            // response is delivered to nobody and the caller times out (same class of bug as
            // #519's resume paths). Cancel this exact listener (identity-bound, never a
            // key-based lookup) on the only early-exit below so it isn't left waiting out the
            // full timeout for nothing.
            const listener = engineResponseWatcher(logger).oneTimeListener<EngineHttpResponse>(webhookRequestId, true, timeoutMs ?? WEBHOOK_TIMEOUT_MS, SYNC_RUN_TIMEOUT_RESPONSE)

            const { data: createdRun, error } = await tryCatch(() => flowRunService(logger).start({
                platformId,
                environment: runEnvironment,
                flowId: flow.id,
                flowVersionId: flowVersionIdToRun,
                payload,
                workerHandlerId,
                projectId,
                executeTrigger: true,
                httpRequestId: webhookRequestId,
                executionType: ExecutionType.BEGIN,
                streamStepProgress: StreamStepProgress.NONE,
                parentRunId,
                failParentOnFailure,
                parentWaitpointId,
                parentSlotId,
                syncDeadline,
                inheritedRunLocale,
            }))
            if (error) {
                listener.cancel()
                throw error
            }

            span.setAttribute('webhook.runId', createdRun.id)
            params.onRunCreated?.(createdRun)

            return await listener.promise
        }
        finally {
            span.end()
        }
    })
}

async function savePayload(params: Omit<AsyncWebhookParams, 'saveSampleData' | 'webhookHeader' | 'execute'>): Promise<void> {
    const { flow, logger, webhookRequestId, payload, flowVersionIdToRun, runEnvironment, parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId, platformId } = params
    await handleAsync({
        flow,
        logger,
        webhookRequestId,
        payload,
        flowVersionIdToRun,
        saveSampleData: true,
        runEnvironment,
        execute: false,
        webhookHeader: '',
        platformId,
        parentRunId,
        failParentOnFailure,
        parentWaitpointId,
        parentSlotId,
    })
    await triggerSourceService(logger).disable({ flowId: flow.id, projectId: flow.projectId, simulate: true, ignoreError: true })
}

/**
 * `parentRunId` naming a run in this same project is not enough to trust `failParentOnFailure`:
 * anyone who can call this project's own public webhooks can guess or already know another run's
 * id, and a failing child would otherwise complete and resume that run's waitpoint on their
 * behalf (#521 impact item 3 — the same-project variant #520/#525 don't close). `parentWaitpointId`
 * (read from the request body's `callbackUrl`, not a header — see `webhook-request-converter.ts`)
 * must name a PENDING WEBHOOK waitpoint owned by `parentRunId`, in this project.
 *
 * This proof is exactly as strong as the `callbackUrl` capability itself, no stronger: whoever
 * holds that URL could already resume the parent directly (with or without an error), so accepting
 * it here grants nothing beyond what its holder can already do. Any *other* PENDING WEBHOOK
 * waitpoint the same run happens to hold (e.g. an unrelated approval step) does not pass this check
 * on its own, since the id must come from `callbackUrl` and match exactly — and once resolved, the
 * verified id is persisted on the child (`flow-run-service.ts`) so a later failure completes only
 * that one waitpoint, never whichever one the parent happens to hold at that later moment.
 *
 * Anything that fails to verify silently drops `failParentOnFailure` (and the waitpoint id with
 * it) — the run still starts, unattached to any waitpoint completion.
 */
async function resolveParentAttachment({ parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId, projectId, logger }: ResolveParentAttachmentParams): Promise<ResolvedParentAttachment> {
    const dropped: ResolvedParentAttachment = { failParentOnFailure: false, parentWaitpointId: undefined, parentSlotId: undefined }
    if (!failParentOnFailure || isNil(parentRunId)) {
        return dropped
    }
    if (isNil(parentWaitpointId)) {
        logger.warn({ parentRunId }, '[webhookService#resolveParentAttachment] Dropping failParentOnFailure: no parent waitpoint proof was presented')
        return dropped
    }
    // A join waitpoint (#374) additionally needs one of its own PENDING slots: its id is in every
    // child's callback URL, so on its own it proves nothing about which child this is.
    const proof = await waitpointService(logger).findVerifiedParentJoinSlot({ parentRunId, parentWaitpointId, parentSlotId, projectId })
    if (!proof.waitpointProven || (proof.isJoin && !proof.slotProven)) {
        // Deliberately not logging `parentWaitpointId` alongside `parentRunId`: that pair is a
        // resume URL for the parent run.
        logger.warn({ parentRunId }, '[webhookService#resolveParentAttachment] Dropping failParentOnFailure: parent waitpoint proof did not match')
        return dropped
    }
    return { failParentOnFailure: true, parentWaitpointId, parentSlotId: proof.isJoin ? parentSlotId : undefined }
}

type HandleWebhookParams = {
    flowId: string
    async: boolean
    saveSampleData: boolean
    flowVersionToRun: WebhookFlowVersionToRun
    data: (projectId: string) => Promise<EventPayload>
    logger: FastifyBaseLogger
    payload?: Record<string, unknown>
    execute: boolean
    onRunCreated?: (run: FlowRun) => void
    parentRunId?: string
    failParentOnFailure: boolean
    parentWaitpointId?: string
    parentSlotId?: string
    timeoutMs?: number
    inheritedRunLocale?: string
}

type ResolveParentAttachmentParams = {
    parentRunId: string | undefined
    failParentOnFailure: boolean
    parentWaitpointId: string | undefined
    parentSlotId: string | undefined
    projectId: ProjectId
    logger: FastifyBaseLogger
}

type ResolvedParentAttachment = {
    failParentOnFailure: boolean
    parentWaitpointId: string | undefined
    parentSlotId: string | undefined
}

type AsyncWebhookParams = {
    flow: Flow
    logger: FastifyBaseLogger
    webhookRequestId: string
    platformId: PlatformId
    payload: unknown
    flowVersionIdToRun: FlowVersionId
    webhookHeader: string
    saveSampleData: boolean
    runEnvironment: RunEnvironment
    execute: boolean
    parentRunId?: string
    failParentOnFailure: boolean
    parentWaitpointId?: string
    parentSlotId?: string
    inheritedRunLocale?: string
}

type SyncWebhookParams = {
    payload: unknown
    saveSampleData: boolean
    projectId: ProjectId
    runEnvironment: RunEnvironment
    platformId: PlatformId
    flowVersionToRun: WebhookFlowVersionToRun
    flow: Flow
    logger: FastifyBaseLogger
    webhookRequestId: string
    workerHandlerId: string
    flowVersionIdToRun: FlowVersionId
    onRunCreated?: (run: FlowRun) => void
    parentRunId?: string
    failParentOnFailure: boolean
    parentWaitpointId?: string
    parentSlotId?: string
    timeoutMs?: number
    inheritedRunLocale?: string
}

import {
    EngineHttpResponse,
    FlowStatus,
    FlowVersionId,
    isNil,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    RunEnvironment,
    StreamStepProgress,
    WebsocketServerEvent,
} from '@aiqadam/shared'
import { context, propagation } from '@opentelemetry/api'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { websocketService } from '../../core/websockets.service'
import { flowExecutionCache } from '../../flows/flow/flow-execution-cache'
import { flowRunService } from '../../flows/flow-run/flow-run-service'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { engineResponseWatcher } from '../engine-response-watcher'
import { payloadOffloader } from '../payload-offloader'
import { InlineSubflowParams, InlineSubflowResult, validateInlineDepth } from './common'

const WEBHOOK_TIMEOUT_MS = system.getNumberOrThrow(AppSystemProp.WEBHOOK_TIMEOUT_SECONDS) * 1000

async function getFlowVersionIdToRun(
    log: FastifyBaseLogger,
    flowId: string,
    versionId: string | undefined,
    publishedVersionId: string | undefined,
): Promise<FlowVersionId> {
    if (!isNil(versionId)) {
        return versionId
    }
    if (!isNil(publishedVersionId)) {
        return publishedVersionId
    }
    const latestVersion = await flowVersionService(log).getLatestLockedVersionOrThrow(flowId)
    return latestVersion.id
}

export const inlineSubflowService = (log: FastifyBaseLogger) => ({
    async executeInline(params: InlineSubflowParams): Promise<InlineSubflowResult> {
        const childDepth = (params.inlineDepth ?? 0) + 1
        validateInlineDepth(childDepth)

        const cacheResult = await flowExecutionCache(log).get({
            flowId: params.flowId,
            simulate: false,
        })

        if (!cacheResult.exists) {
            return { ok: false, error: 'Flow not found' }
        }

        const { flow } = cacheResult
        if (flow.status !== FlowStatus.ENABLED) {
            return { ok: false, error: 'Flow is disabled' }
        }

        const flowVersionId = await getFlowVersionIdToRun(
            log,
            flow.id,
            params.versionId,
            flow.publishedVersionId ?? undefined,
        )
        const platformId = cacheResult.platformId

        const flowRun = await flowRunService(log).startForInline({
            flowId: params.flowId,
            flowVersionId,
            projectId: flow.projectId,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: params.parentRunId,
            failParentOnFailure: params.failParentOnFailure,
        })

        const webhookRequestId = flowRun.id

        const traceContext: Record<string, string> = {}
        propagation.inject(context.active(), traceContext)

        const jobPayload = await payloadOffloader.maybeOffloadPayload(
            log,
            params.payload,
            flow.projectId,
            platformId,
        )

        const inlineFlowCommand = {
            requestId: webhookRequestId,
            platformId,
            projectId: flow.projectId,
            schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            payload: jobPayload,
            environment: RunEnvironment.PRODUCTION,
            streamStepProgress: StreamStepProgress.NONE,
            flowId: flow.id,
            flowVersionId,
            runId: webhookRequestId,
            workerHandlerId: null,
            httpRequestId: webhookRequestId,
            traceContext,
            inlineDepth: childDepth,
        }

        websocketService.to('*').emit(WebsocketServerEvent.EXECUTE_INLINE_FLOW, inlineFlowCommand)

        const listenerResult = await engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(
            webhookRequestId,
            true,
            WEBHOOK_TIMEOUT_MS,
            {
                status: StatusCodes.OK,
                body: { status: 'success', data: undefined },
                headers: {},
            },
        )

        const childResult = listenerResult.body as { status: string, data?: unknown } | undefined

        const updatedFlowRun = await flowRunService(log).getOneOrThrow({
            id: flowRun.id,
            projectId: flow.projectId,
        })

        return {
            ok: true,
            data: {
                status: childResult?.status ?? 'success',
                data: childResult?.data,
                runId: flowRun.id,
                childStatus: updatedFlowRun.status,
            },
        }
    },
})

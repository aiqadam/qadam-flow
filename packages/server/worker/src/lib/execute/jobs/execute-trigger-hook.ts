import {
    EngineOperationType,
    EngineResponseStatus,
    ExecuteTriggerHookJobData,
    isNil,
    TriggerHookType,
    tryCatch,
    WorkerJobType,
} from '@aiqadam/shared'
import { flowCache } from '../../cache/flow/flow-cache'
import { workerSettings } from '../../config/worker-settings'
import { JobContext, JobHandler, JobResultKind, SynchronousJobResult } from '../types'
import { provisionFlowPieces } from '../utils/flow-helpers'
import { isSandboxTimeout } from '../utils/sandbox-helpers'
import { getWebhookUrl } from '../utils/webhook-url'

export const executeTriggerHookJob: JobHandler<ExecuteTriggerHookJobData, SynchronousJobResult> = {
    jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
    async execute(ctx: JobContext, data: ExecuteTriggerHookJobData): Promise<SynchronousJobResult> {
        const timeoutInSeconds = workerSettings.getSettings().TRIGGER_HOOKS_TIMEOUT_SECONDS

        const flowVersion = await flowCache(ctx.log, ctx.apiClient).getVersion({ flowVersionId: data.flowVersionId })
        if (!flowVersion) {
            ctx.log.info({ flowVersionId: data.flowVersionId }, 'Flow version not found for trigger hook, skipping')
            return { kind: JobResultKind.SYNCHRONOUS, status: EngineResponseStatus.OK, response: undefined }
        }

        const provision = await provisionFlowPieces({ flowVersion, platformId: data.platformId, flowId: data.flowId, projectId: data.projectId, log: ctx.log, apiClient: ctx.apiClient })
        if (!provision.provisioned) {
            ctx.log.info({ flowId: data.flowId, hookType: data.hookType, unavailableQadam: provision.unavailableQadam }, 'Failed to provision qadams for trigger hook')
            // ON_DISABLE must still succeed: refusing to disable a flow whose pin is gone would make
            // the broken flow impossible to turn off, which is the opposite of what #432 wants. Every
            // other hook — ON_ENABLE above all — reports the failure, so `assertEngineResponseIsOk`
            // raises and enabling or publishing fails with the pin named, instead of returning OK and
            // leaving a flow that reads ENABLED and registers no webhook and polls nothing.
            if (data.hookType === TriggerHookType.ON_DISABLE) {
                return { kind: JobResultKind.SYNCHRONOUS, status: EngineResponseStatus.OK, response: undefined }
            }
            return {
                kind: JobResultKind.SYNCHRONOUS,
                status: EngineResponseStatus.INTERNAL_ERROR,
                response: undefined,
                errorMessage: `This flow has a step pinned to ${provision.unavailableQadam}, which this installation does not have. Re-point that step at an available version — ap_validate_flow lists it — then enable the flow again.`,
            }
        }

        const sandbox = ctx.sandboxManager.acquire({ log: ctx.log, apiClient: ctx.apiClient })
        const { data: result, error } = await tryCatch(async () => {
            await sandbox.start({
                flowVersionId: flowVersion.id,
                platformId: data.platformId,
                mounts: [],
            })

            return sandbox.execute(
                EngineOperationType.EXECUTE_TRIGGER_HOOK,
                {
                    hookType: data.hookType,
                    flowVersion,
                    webhookUrl: getWebhookUrl(ctx.publicApiUrl, data.flowId, data.test),
                    triggerPayload: isNil(data.triggerPayload) ? undefined : { type: 'inline', value: data.triggerPayload },
                    test: data.test,
                    projectId: data.projectId,
                    platformId: data.platformId,
                    engineToken: ctx.engineToken,
                    internalApiUrl: ctx.internalApiUrl,
                    publicApiUrl: ctx.publicApiUrl,
                    timeoutInSeconds,
                },
                { timeoutInSeconds },
            )
        })
        await ctx.sandboxManager.release(ctx.log)

        if (error) {
            await ctx.sandboxManager.invalidate(ctx.log)
            if (isSandboxTimeout(error)) {
                return { kind: JobResultKind.SYNCHRONOUS, status: EngineResponseStatus.TIMEOUT, response: undefined }
            }
            throw error
        }

        return {
            kind: JobResultKind.SYNCHRONOUS,
            status: result.status,
            response: result.response,
            errorMessage: result.error,
            logs: result.logs,
        }
    },
}

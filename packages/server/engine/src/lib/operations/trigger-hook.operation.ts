import { inspect } from 'util'
import {
    EngineResponse,
    EngineResponseStatus,
    ExecuteTriggerOperation,
    ExecuteTriggerResponse,
    formatQadamError,
    TriggerHookType,
} from '@aiqadam/shared'
import { EngineConstants, ResolvedExecuteTriggerOperation } from '../handler/context/engine-constants'
import { triggerHelper } from '../helper/trigger-helper'
import { retryingFetch } from '../retrying-fetch'
import { utils } from '../utils'
import { resolveJobPayload } from './utils/resolve-job-payload'


export const triggerHookOperation = {
    execute: async (operation: ExecuteTriggerOperation<TriggerHookType>): Promise<EngineResponse<ExecuteTriggerResponse<TriggerHookType>>> => {
        // This runs before EngineConstants exists, essentially at this operation's own t=0, so
        // `executionStartedAt: Date.now()` here is that operation's own clock (#604) — the same
        // TRIGGER_TIMEOUT_SECONDS deadline `EngineConstants.fromExecuteTriggerInput` below will use.
        const input: ResolvedExecuteTriggerOperation<TriggerHookType> = {
            ...operation,
            triggerPayload: await resolveJobPayload({
                payload: operation.triggerPayload,
                apiUrl: operation.internalApiUrl,
                engineToken: operation.engineToken,
                retryPolicy: retryingFetch.forOperationDeadline({ timeoutInSeconds: operation.timeoutInSeconds, executionStartedAt: Date.now() }),
            }),
        }
        const { data: output, error } = await utils.tryCatchAndThrowOnEngineError(() =>
            triggerHelper.executeTrigger({
                params: input,
                constants: EngineConstants.fromExecuteTriggerInput(input),
            }),
        )
        if (error) {
            return {
                status: EngineResponseStatus.USER_FAILURE,
                response: undefined as unknown as ExecuteTriggerResponse<TriggerHookType>,
                error: JSON.stringify(formatQadamError(error, { raw: inspect(error) })),
            }
        }
        return {
            status: EngineResponseStatus.OK,
            response: output,
        }
    },
}
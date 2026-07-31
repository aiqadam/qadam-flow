import { apVersionUtil } from '@aiqadam/server-utils'
import {
    ExecutionMode,
    isNil,
    NetworkMode,
    WorkerMachineHealthcheckRequest,
    WorkerMachineStatus,
    WorkerMachineType,
    WorkerMachineWithStatus,
    WorkerSettingsResponse,
} from '@aiqadam/shared'

import { FastifyBaseLogger } from 'fastify'
import { domainHelper } from '../../helper/domain-helper'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { workerMachineCache } from './machine-cache'

const settingsCache = new Map<string, WorkerSettingsResponse>()

async function buildSettingsResponse(_log: FastifyBaseLogger): Promise<WorkerSettingsResponse> {
    const cacheKey = '__shared__'
    const cached = settingsCache.get(cacheKey)
    if (cached) {
        return cached
    }
    const executionMode = system.getOrThrow<ExecutionMode>(AppSystemProp.EXECUTION_MODE)
    const settings = {
        TRIGGER_TIMEOUT_SECONDS: system.getNumberOrThrow(AppSystemProp.TRIGGER_TIMEOUT_SECONDS),
        PAUSED_FLOW_TIMEOUT_DAYS: system.getNumberOrThrow(AppSystemProp.PAUSED_FLOW_TIMEOUT_DAYS),
        EXECUTION_MODE: executionMode,
        TRIGGER_HOOKS_TIMEOUT_SECONDS: system.getNumberOrThrow(AppSystemProp.TRIGGER_HOOKS_TIMEOUT_SECONDS),
        FLOW_TIMEOUT_SECONDS: system.getNumberOrThrow(AppSystemProp.FLOW_TIMEOUT_SECONDS),
        LOG_LEVEL: system.getOrThrow(AppSystemProp.LOG_LEVEL),
        LOG_PRETTY: system.getOrThrow(AppSystemProp.LOG_PRETTY),
        ENVIRONMENT: system.getOrThrow(AppSystemProp.ENVIRONMENT),
        APP_WEBHOOK_SECRETS: system.getOrThrow(AppSystemProp.APP_WEBHOOK_SECRETS),
        MAX_FLOW_RUN_LOG_SIZE_MB: system.getNumberOrThrow(AppSystemProp.MAX_FLOW_RUN_LOG_SIZE_MB),
        MAX_FILE_SIZE_MB: system.getNumberOrThrow(AppSystemProp.MAX_FILE_SIZE_MB),
        SANDBOX_MEMORY_LIMIT: system.getOrThrow(AppSystemProp.SANDBOX_MEMORY_LIMIT),
        SANDBOX_PROPAGATED_ENV_VARS: system.get(AppSystemProp.SANDBOX_PROPAGATED_ENV_VARS)?.split(',').map(f => f.trim()) ?? [],
        DEV_QADAMS: system.get(AppSystemProp.DEV_QADAMS)?.split(',') ?? [],
        SENTRY_DSN: system.get(AppSystemProp.SENTRY_DSN),
        LOKI_PASSWORD: system.get(AppSystemProp.LOKI_PASSWORD),
        LOKI_URL: system.get(AppSystemProp.LOKI_URL),
        LOKI_USERNAME: system.get(AppSystemProp.LOKI_USERNAME),
        BETTERSTACK_HOST: system.get(AppSystemProp.BETTERSTACK_HOST),
        BETTERSTACK_TOKEN: system.get(AppSystemProp.BETTERSTACK_TOKEN),
        OTEL_ENABLED: system.get(AppSystemProp.OTEL_ENABLED) === 'true',
        PUBLIC_URL: await domainHelper.getPublicUrl({
            path: '',
        }),
        FILE_STORAGE_LOCATION: system.getOrThrow(AppSystemProp.FILE_STORAGE_LOCATION),
        S3_USE_SIGNED_URLS: system.getOrThrow(AppSystemProp.S3_USE_SIGNED_URLS),
        EVENT_DESTINATION_TIMEOUT_SECONDS: system.getNumberOrThrow(AppSystemProp.EVENT_DESTINATION_TIMEOUT_SECONDS),
        SSRF_ALLOW_LIST: system.get(AppSystemProp.SSRF_ALLOW_LIST)?.split(',').map(f => f.trim()) ?? [],
        NETWORK_MODE: system.getOrThrow<NetworkMode>(AppSystemProp.NETWORK_MODE),
        PAGE_ONCALL_WEBHOOK: system.get(AppSystemProp.PAGE_ONCALL_WEBHOOK),
        APP_VERSION: apVersionUtil.getCurrentRelease(),
    }
    settingsCache.set(cacheKey, settings)
    return settings
}

export const machineService = (log: FastifyBaseLogger) => {
    return {
        async onDisconnect(request: OnDisconnectParams): Promise<void> {
            log.info({
                message: 'Worker disconnected',
                workerId: request.workerId,
            })
            await workerMachineCache().delete([request.workerId])
        },
        // The settings a worker needs to boot, without recording anything. Used when a healthcheck
        // payload fails validation: the payload must not reach the registry, but the worker still
        // has to be told how to run — withholding the ack wedges it (see machine-controller).
        async settingsOnly(): Promise<WorkerSettingsResponse> {
            return buildSettingsResponse(log)
        },
        async onConnection(request: WorkerMachineHealthcheckRequest, workerGroupId?: string | undefined): Promise<WorkerSettingsResponse> {
            const type = isNil(workerGroupId) ? 'SHARED' : 'DEDICATED'
            await workerMachineCache().upsert({
                id: request.workerId,
                information: request,
                type,
                workerGroupId,
            })
            return buildSettingsResponse(log)
        },
        // `_platformId` is accepted to match both callers' contracts — machine-controller's
        // `GET /v1/worker-machines` and health.service's `GET /v1/health/system`, each
        // platformAdminOnly — but it cannot scope anything yet. WorkerMachine has no platformId
        // field, and no *stored* mapping from a worker group to a platform exists: the model has
        // the idea (`PlatformPlan.workerGroupId`, and `getWorkerGroupQueueName` names queues
        // `platform-<workerGroupId>-jobs`), but there is no platform_plan entity here and
        // `getPlan()` returns a hardcoded object that never sets it (#195, closed not-planned).
        //
        // Whoever implements real dedicated/worker-group listing must, in the same change:
        //   1. make group -> platform a SERVER-side record. `workerGroupId` is now a claim in
        //      the verified worker token rather than a socket-handshake value (#207), so it is
        //      no longer self-asserted — but it still says nothing about which platform owns the
        //      group, and whoever mints a token chooses the string. Filtering on it alone would
        //      still be isolation without a server-side group -> platform mapping.
        //   2. scope the other surface too, not just the filter below:
        //      `GET /v1/worker-machines/queue-metrics` returns every queue name — which embeds
        //      the group id — to any platform admin.
        // The isolation test in machine-list-filter.test.ts fails the moment a DEDICATED worker
        // is returned to anyone, so it guards step 2's filter but not the other surface.
        //
        // Reading is all this does now: entries expire in Redis (WORKER_MACHINE_TTL_SECONDS), so
        // a worker that stopped checking in is already gone by the time anyone lists — the prune
        // that used to live here only ran when someone opened the workers page (#222).
        async list(_platformId: string): Promise<WorkerMachineWithStatus[]> {
            const onlineWorkers = await workerMachineCache().find()

            // SHARED workers are cluster-wide by definition, so every platform admin sees them.
            // DEDICATED workers carry a workerGroupId but nothing in this repo maps a worker
            // group to a platformId (#195, closed not-planned) — there is no data to scope them
            // by platform, so they are dropped for every caller rather than served unscoped.
            return onlineWorkers
                .filter(worker => worker.type !== WorkerMachineType.DEDICATED)
                .map(worker => ({
                    ...worker,
                    status: WorkerMachineStatus.ONLINE,
                    type: WorkerMachineType.SHARED,
                    workerGroupId: worker.workerGroupId,
                }))
        },
    }
}

type OnDisconnectParams = {
    workerId: string
}
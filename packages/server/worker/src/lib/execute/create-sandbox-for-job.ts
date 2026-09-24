import { memoryLock } from '@aiqadam/server-utils'
import { ExecutionMode, FlowRunStatus, isNil, maxSocketHttpBufferSizeBytes, NetworkMode, ResolveInlineFlowResult, WorkerContract, WorkerToApiContract } from '@aiqadam/shared'
import { nanoid } from 'nanoid'
import { Logger } from 'pino'
import { getEnginePath, getGlobalCacheCommonPath, getGlobalCodeCachePath } from '../cache/cache-paths'
import { workerSettings } from '../config/worker-settings'
import { sandboxCapacity } from '../sandbox/capacity'
import { simpleProcess } from '../sandbox/fork'
import { isolateProcess } from '../sandbox/isolate'
import { createSandbox } from '../sandbox/sandbox'
import { Sandbox, SandboxMount } from '../sandbox/types'
import { EngineRunScope, engineRunScope } from './engine-run-scope'
import { SandboxJobContext } from './sandbox-manager'
import { provisionFlowPieces } from './utils/flow-helpers'

export function createSandboxForJob(params: {
    log: Logger
    apiClient: WorkerToApiContract
    boxId: number
    reusable: boolean
    proxyPort: number | null
    getCurrentJobContext: () => SandboxJobContext | null
}): Sandbox {
    const { log, apiClient, boxId, reusable, proxyPort, getCurrentJobContext } = params
    const settings = workerSettings.getSettings()
    const sandboxId = nanoid()

    const runScope = engineRunScope.create({ log, getCurrentJobContext })

    const workerHandlers: WorkerContract = {
        updateRunProgress: async (input) => {
            runScope.assertOwnsRun({ rpc: 'updateRunProgress', runId: input.flowRun.id, projectId: input.flowRun.projectId })
            return apiClient.updateRunProgress(input)
        },
        uploadRunLog: async (input) => {
            runScope.assertOwnsRun({ rpc: 'uploadRunLog', runId: input.runId, projectId: input.projectId })
            return apiClient.uploadRunLog(input)
        },
        sendFlowResponse: async (input) => {
            runScope.assertOwnsSyncRequest({ workerHandlerId: input.workerHandlerId, httpRequestId: input.httpRequestId })
            return apiClient.sendFlowResponse(input)
        },
        updateStepProgress: async (input) => {
            runScope.assertOwnsRun({ rpc: 'updateStepProgress', runId: input.stepResponse.runId, projectId: input.projectId })
            return apiClient.updateStepProgress(input)
        },
        resolveInlineFlow: async (input) => {
            const jobContext = getCurrentJobContext()
            const result = await resolveInlineFlow({ input, log, apiClient, jobContext, runScope })
            if (result.ok && !isNil(jobContext)) {
                runScope.recordInlineChild({ jobContext, childRunId: result.childRunId })
            }
            return result
        },
    }

    const memoryLimitMb = parseMemoryLimit(settings.SANDBOX_MEMORY_LIMIT)
    const processMaker = getProcessMaker(settings.EXECUTION_MODE, log, boxId)

    const baseMounts: SandboxMount[] = [
        { hostPath: getGlobalCacheCommonPath(), sandboxPath: '/root/common' },
    ]

    const executionMode = settings.EXECUTION_MODE as ExecutionMode

    return createSandbox(
        log,
        sandboxId,
        {
            env: buildSandboxEnv({ settings, proxyPort }),
            memoryLimitMb,
            cpuMsPerSec: 1000,
            timeLimitSeconds: settings.FLOW_TIMEOUT_SECONDS,
            reusable,
            maxHttpBufferSizeBytes: maxSocketHttpBufferSizeBytes(settings.MAX_FILE_SIZE_MB),
            baseMounts,
            wsRpcPort: isIsolateMode(executionMode) ? sandboxCapacity.wsRpcPortForBox(boxId) : undefined,
        },
        processMaker,
        workerHandlers,
    )
}

export function isIsolateMode(mode: ExecutionMode): boolean {
    return mode === ExecutionMode.SANDBOX_PROCESS || mode === ExecutionMode.SANDBOX_CODE_AND_PROCESS
}

async function resolveInlineFlow(params: {
    input: { flowId: string, payload: unknown, parentRunId: string }
    log: Logger
    apiClient: WorkerToApiContract
    jobContext: SandboxJobContext | null
    runScope: EngineRunScope
}): Promise<ResolveInlineFlowResult> {
    const { input, log, apiClient, jobContext, runScope } = params
    if (isNil(jobContext)) {
        return { ok: false, error: 'Inline subflows are only supported when called from a running flow.' }
    }

    // callerProjectId/callerPlatformId/environment come from the worker's own
    // trusted current-job identity — never from the engine. parentRunId is the
    // one field that MUST come from the engine's own current run (`input.parentRunId`,
    // not `jobContext.runId`): a nested inline call (child calling another
    // child inline) is nested under the immediate parent's run, not the outermost
    // job's — using the job-level value here would let cyclic inline flows recurse
    // unbounded, since every nested call would report the same ancestor to the depth
    // guard. The API only checks that `parentRunId` is a run in `callerProjectId`, and
    // every child it creates fails its parent on failure, so the parent must also be
    // held to this job's own run tree here: otherwise the engine could fail and resume
    // any other paused run in the project (#525).
    runScope.assertOwnsRun({ rpc: 'resolveInlineFlow', runId: input.parentRunId, projectId: jobContext.projectId })
    const started = await apiClient.startInlineFlowRun({
        callerProjectId: jobContext.projectId,
        callerPlatformId: jobContext.platformId,
        parentRunId: input.parentRunId,
        environment: jobContext.environment,
        flowId: input.flowId,
        payload: input.payload,
    })
    if (!started.ok) {
        return started
    }

    // A CONCURRENT loop can start several inline children of one job at once, all provisioning onto
    // the same sandbox filesystem (#387) — the same class of race #372 fixed across replicas. The
    // installer's own file lock covers `bun install`, not the rest of provisioning.
    const provisioned = await memoryLock.runExclusive({
        key: `inline-provision-${jobContext.runId}`,
        fn: () => provisionFlowPieces({
            flowVersion: started.flowVersion,
            platformId: jobContext.platformId,
            flowId: started.flowVersion.flowId,
            projectId: jobContext.projectId,
            log,
            apiClient,
        }),
    })
    if (!provisioned.provisioned) {
        // The child FlowRun row already exists (created above) — leaving it RUNNING
        // forever would be a stuck run with no reaper anywhere in the codebase, since
        // execution never reaches inline-flow-executor.ts's own finalize step.
        await apiClient.uploadRunLog({
            runId: started.childRunId,
            projectId: jobContext.projectId,
            status: FlowRunStatus.INTERNAL_ERROR,
            finishTime: new Date().toISOString(),
        })
        return { ok: false, error: 'Failed to provision the subflow\'s pieces.' }
    }

    return started
}

function getProcessMaker(executionMode: string, log: Logger, boxId: number) {
    switch (executionMode) {
        case ExecutionMode.SANDBOX_PROCESS:
        case ExecutionMode.SANDBOX_CODE_AND_PROCESS:
            return isolateProcess(log, getEnginePath(), getGlobalCodeCachePath(), boxId)
        case ExecutionMode.UNSANDBOXED:
        case ExecutionMode.SANDBOX_CODE_ONLY:
        default:
            return simpleProcess(getEnginePath(), getGlobalCodeCachePath())
    }
}

function parseMemoryLimit(memoryLimitKb: string): number {
    const parsed = parseInt(memoryLimitKb, 10)
    const kb = isNaN(parsed) ? 1048576 : parsed
    return Math.floor(kb / 1024)
}

function buildSandboxEnv({ settings, proxyPort }: {
    settings: WorkerSettings
    proxyPort: number | null
}): Record<string, string> {
    // `proxyPort` reflects what the egress stack actually started at worker boot:
    // non-null means the proxy is listening AND the iptables UID-owner REJECT chain is
    // armed. `settings.NETWORK_MODE` is refreshed on every socket reconnect, so reading
    // it here can drift away from the firewall the worker already armed. If the
    // platform flips STRICT → UNRESTRICTED at reconnect, reading the live setting would
    // drop AP_EGRESS_PROXY_URL from the sandbox env while iptables stays in place —
    // user fetches then fall back to direct connect, hit the REJECT chain, and surface
    // EHOSTUNREACH / "fetch failed". Keying the entire network env off proxyPort keeps
    // the env var, the engine's ssrfGuard, and the kernel firewall on the same axis.
    const networkMode = proxyPort === null ? NetworkMode.UNRESTRICTED : NetworkMode.STRICT
    return {
        ...baseEnv({ settings, networkMode }),
        ...ssrfEnv(settings),
        ...propagatedEnv({ settings, networkMode }),
        ...proxyEnv({ proxyPort }),
    }
}

function baseEnv({ settings, networkMode }: { settings: WorkerSettings, networkMode: NetworkMode }): Record<string, string> {
    return {
        HOME: '/tmp/',
        AP_EXECUTION_MODE: settings.EXECUTION_MODE,
        AP_MAX_FLOW_RUN_LOG_SIZE_MB: String(settings.MAX_FLOW_RUN_LOG_SIZE_MB),
        AP_MAX_FILE_SIZE_MB: String(settings.MAX_FILE_SIZE_MB),
        ...(settings.LOOP_MAX_CONCURRENCY !== undefined ? { AP_LOOP_MAX_CONCURRENCY: String(settings.LOOP_MAX_CONCURRENCY) } : {}),
        NODE_PATH: '/usr/src/node_modules',
        AP_NETWORK_MODE: networkMode,
    }
}

function ssrfEnv(settings: WorkerSettings): Record<string, string> {
    const env: Record<string, string> = {}
    if (settings.DEV_QADAMS.length > 0) {
        env['AP_DEV_QADAMS'] = settings.DEV_QADAMS.join(',')
    }
    if (settings.SSRF_ALLOW_LIST.length > 0) {
        env['AP_SSRF_ALLOW_LIST'] = settings.SSRF_ALLOW_LIST.join(',')
    }
    return env
}

function proxyEnv({ proxyPort }: { proxyPort: number | null }): Record<string, string> {
    if (proxyPort === null) {
        return {}
    }
    // Never export standard HTTP_PROXY / HTTPS_PROXY env vars: axios's built-in
    // proxy-from-env path sends `GET https://…` absolute-URL requests to an HTTP
    // proxy instead of issuing CONNECT, which proxy-chain rejects with 400
    // "Only HTTP protocol is supported". AP_EGRESS_PROXY_URL is a private signal
    // read by the engine to install http/https globalAgent + undici ProxyAgent.
    return {
        AP_EGRESS_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    }
}

function propagatedEnv({ settings, networkMode }: { settings: WorkerSettings, networkMode: NetworkMode }): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of settings.SANDBOX_PROPAGATED_ENV_VARS) {
        if (STRICT_MODE_BLOCKED_PROPAGATED_KEYS.has(key) && networkMode === NetworkMode.STRICT) {
            continue
        }
        if (process.env[key]) {
            env[key] = process.env[key]!
        }
    }
    return env
}

const STRICT_MODE_BLOCKED_PROPAGATED_KEYS = new Set([
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
])

type WorkerSettings = ReturnType<typeof workerSettings.getSettings>

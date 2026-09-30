import { ApEnvironment, ExecutionMode, isNil, RunEnvironment, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { provisioner } from '../cache/provisioner'
import { system, WorkerSystemProp } from '../config/configs'
import { workerSettings } from '../config/worker-settings'
import { Sandbox } from '../sandbox/types'
import { createSandboxForJob } from './create-sandbox-for-job'

export function createSandboxManager({ boxId, proxyPort }: { boxId: number, proxyPort: number | null }): SandboxManager {
    let currentSandbox: Sandbox | null = null
    let currentJobContext: SandboxJobContext | null = null

    // Only reusable sandboxes: a single-use one would be thrown away by the first job's release.
    async function startPrewarmedSandbox({ log, apiClient }: PrewarmParams): Promise<void> {
        if (!canReuseSandbox() || !isNil(currentSandbox)) {
            return
        }
        const startedAt = performance.now()
        await provisioner(log, apiClient).provision({ pieces: [], codeSteps: [] })
        const sandbox = createSandboxForJob({
            log,
            apiClient,
            boxId,
            reusable: true,
            proxyPort,
            getCurrentJobContext: () => currentJobContext,
        })
        currentSandbox = sandbox
        const { error: startError } = await tryCatch(() => sandbox.start({ flowVersionId: undefined, platformId: '', mounts: [] }))
        // Invalidated while it was starting (a stop or a reconnect): nothing references it any more.
        if (startError || currentSandbox !== sandbox) {
            if (currentSandbox === sandbox) {
                currentSandbox = null
            }
            await sandbox.shutdown()
            if (startError) {
                throw startError
            }
            return
        }
        log.info({ boxId, sandboxId: sandbox.id, prewarmMs: Math.round(performance.now() - startedAt) }, '[sandboxManager#prewarm] Sandbox started before its first job')
    }

    return {
        acquire(params: { log: Logger, apiClient: WorkerToApiContract, jobContext?: SandboxJobContext }): Sandbox {
            currentJobContext = params.jobContext ?? null
            if (canReuseSandbox() && currentSandbox && currentSandbox.isReady()) {
                return currentSandbox
            }
            if (currentSandbox) {
                params.log.info('Sandbox not ready or not reusable, creating fresh one')
                currentSandbox.shutdown().catch((err) =>
                    params.log.error({ err }, 'Error shutting down previous sandbox'),
                )
            }
            currentSandbox = createSandboxForJob({
                log: params.log,
                apiClient: params.apiClient,
                boxId,
                reusable: canReuseSandbox(),
                proxyPort,
                getCurrentJobContext: () => currentJobContext,
            })
            return currentSandbox
        },
        // #419: spawn this slot's engine before its first job, so the job does not pay the process
        // start and the engine's own cold loads (see engine-warmup.ts). Called by the slot's poll loop
        // before it polls, so no job can be acquiring this manager at the same time. Best effort: on
        // any failure the slot still polls, and its first job starts a sandbox as it always did.
        async prewarm(params: PrewarmParams): Promise<void> {
            const { error } = await tryCatch(() => startPrewarmedSandbox(params))
            if (error) {
                params.log.warn({ boxId, error }, '[sandboxManager#prewarm] Prewarm failed, the first job will start the sandbox')
            }
        },
        async invalidate(log: Logger): Promise<void> {
            if (currentSandbox) {
                log.info('Invalidating sandbox')
                const sb = currentSandbox
                currentSandbox = null
                await sb.shutdown()
            }
        },
        async release(log: Logger): Promise<void> {
            if (!canReuseSandbox()) {
                await this.invalidate(log)
            }
        },
        async shutdown(log: Logger): Promise<void> {
            await this.invalidate(log)
        },
        getActiveSandbox(): ActiveSandboxInfo | null {
            if (isNil(currentSandbox) || !currentSandbox.isReady()) {
                return null
            }
            const pid = currentSandbox.getPid()
            if (isNil(pid)) {
                return null
            }
            return {
                sandboxId: currentSandbox.id,
                boxId,
                pid,
                busy: currentSandbox.isBusy(),
            }
        },
    }
}

function canReuseSandbox(): boolean {
    const reuseSandbox = system.get(WorkerSystemProp.REUSE_SANDBOX)
    if (!isNil(reuseSandbox)) {
        return reuseSandbox === 'true'
    }
    const settings = workerSettings.getSettings()
    if (settings.ENVIRONMENT === ApEnvironment.DEVELOPMENT) {
        return true
    }
    const trustedModes = [ExecutionMode.SANDBOX_CODE_ONLY, ExecutionMode.UNSANDBOXED]
    if (trustedModes.includes(settings.EXECUTION_MODE as ExecutionMode)) {
        return true
    }
    return false
}

export type ActiveSandboxInfo = {
    sandboxId: string
    boxId: number
    pid: number
    busy: boolean
}

export type SandboxManager = {
    acquire(params: { log: Logger, apiClient: WorkerToApiContract, jobContext?: SandboxJobContext }): Sandbox
    prewarm(params: PrewarmParams): Promise<void>
    invalidate(log: Logger): Promise<void>
    release(log: Logger): Promise<void>
    shutdown(log: Logger): Promise<void>
    getActiveSandbox(): ActiveSandboxInfo | null
}

// The trusted identity of the job currently occupying this manager's sandbox — the
// ONLY source the WorkerContract handlers may use to scope what the engine asks for:
// `resolveInlineFlow` scopes an inline `callFlow` target by it, and the run-scoped
// RPCs (`uploadRunLog`, progress, `sendFlowResponse`) are refused for any run,
// project or sync request it does not name (#512).
// Sandboxes can be reused across many jobs (dev/trusted execution modes), so this is
// a mutable ref updated on every `acquire()`, read fresh by the WorkerContract
// handlers at call time rather than captured once at sandbox-creation time.
export type SandboxJobContext = {
    runId: string
    projectId: string
    platformId: string
    environment: RunEnvironment
    workerHandlerId: string | null
    httpRequestId: string | null
}

type PrewarmParams = {
    log: Logger
    apiClient: WorkerToApiContract
}

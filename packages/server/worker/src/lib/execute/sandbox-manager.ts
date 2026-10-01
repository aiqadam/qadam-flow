import { ApEnvironment, ExecutionMode, isNil, RunEnvironment, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { provisioner } from '../cache/provisioner'
import { system, WorkerSystemProp } from '../config/configs'
import { workerSettings } from '../config/worker-settings'
import { Sandbox } from '../sandbox/types'
import { createSandboxForJob, isIsolateMode } from './create-sandbox-for-job'

export function createSandboxManager({ boxId, proxyPort }: { boxId: number, proxyPort: number | null }): SandboxManager {
    let currentSandbox: Sandbox | null = null
    let currentJobContext: SandboxJobContext | null = null
    // Bumped by every invalidate, and so every shutdown: a prewarm still provisioning or starting
    // can then tell that its slot was let go, and must not leave an engine running for nobody.
    // Managers outlive a reconnect (#585), so a reconnect is not a let-go and bumps nothing. That is
    // safe because the manager's own poll loop is its only user: the loop prewarms once, before its
    // first poll, and a reconnect starts no second loop, so a prewarm never overlaps a job or another
    // prewarm on this manager. What does let a slot go (a stop, a settings change that recycles an
    // idle slot, a lost lease) goes through invalidate.
    let generation = 0

    // Only reusable sandboxes: a single-use one would be thrown away by the first job's release.
    // And only forked engines, which ignore mounts: an isolate sandbox that is reused (dev, or
    // AP_REUSE_SANDBOX) mounts its first job's platform's custom qadams at start, and a prewarmed
    // one, started with no platform, would never get them.
    async function startPrewarmedSandbox({ log, apiClient }: PrewarmParams): Promise<void> {
        const { EXECUTION_MODE } = workerSettings.getSettings()
        if (!prewarmEnabled() || !canReuseSandbox() || isIsolateMode(EXECUTION_MODE) || !isNil(currentSandbox)) {
            return
        }
        const startedAt = performance.now()
        const startGeneration = generation
        await provisioner(log, apiClient).provision({ pieces: [], codeSteps: [] })
        if (generation !== startGeneration) {
            log.debug({ boxId }, '[sandboxManager#prewarm] Slot let go while provisioning, no sandbox started')
            return
        }
        const sandbox = createSandboxForJob({
            log,
            apiClient,
            boxId,
            reusable: true,
            warmup: true,
            proxyPort,
            getCurrentJobContext: () => currentJobContext,
        })
        currentSandbox = sandbox
        const { error: startError } = await tryCatch(() => sandbox.start({ flowVersionId: undefined, platformId: '', mounts: [] }))
        // Let go while it was starting (a stop or a reconnect): nothing references it any more, and a
        // start error then is the shutdown's doing, not a failed prewarm.
        const superseded = generation !== startGeneration || currentSandbox !== sandbox
        if (startError || superseded) {
            if (currentSandbox === sandbox) {
                currentSandbox = null
            }
            const { error: shutdownError } = await tryCatch(() => sandbox.shutdown())
            if (startError && !superseded) {
                throw startError
            }
            if (shutdownError) {
                log.warn({ boxId, error: shutdownError }, '[sandboxManager#prewarm] Could not shut down the sandbox of a slot let go while it started')
                return
            }
            log.debug({ boxId }, '[sandboxManager#prewarm] Slot let go while its sandbox started, sandbox shut down')
            return
        }
        log.info({ boxId, sandboxId: sandbox.id, prewarmMs: Math.round(performance.now() - startedAt) }, '[sandboxManager#prewarm] Sandbox started before its first job')
    }
    // A sandbox bakes the worker settings in at creation (env, limits, mode), so one created
    // before the settings changed must not serve another job — but it may be mid-job right now,
    // and killing it would fail that run (#585). Recycled on the next acquire instead.
    let stale = false

    return {
        acquire(params: { log: Logger, apiClient: WorkerToApiContract, jobContext?: SandboxJobContext }): Sandbox {
            currentJobContext = params.jobContext ?? null
            if (canReuseSandbox() && currentSandbox && currentSandbox.isReady() && !stale) {
                return currentSandbox
            }
            stale = false
            if (currentSandbox) {
                params.log.info('Sandbox not ready, not reusable or stale, creating fresh one')
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
            generation++
            // It described the sandbox going away here; the next one is built with the current settings.
            stale = false
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
        markStale(): void {
            stale = true
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

// On by default; AP_WORKER_PREWARM_ENGINES=false keeps engines lazy, for a host that cannot hold
// every slot's engine from boot (about 100 MiB each).
function prewarmEnabled(): boolean {
    return system.getBoolean(WorkerSystemProp.PREWARM_ENGINES) !== false
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
    markStale(): void
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
    /** Set by the worker on every job's context (`givenUpGuard`): true once the job is no longer this worker's. */
    isGivenUp?: () => boolean
    /**
     * Set with `isGivenUp`: the job's own client, which drops a call at send time once the job is
     * given up. The engine's calls go through it rather than through the client the sandbox was
     * created with, which belongs to whichever job or prewarm started the sandbox.
     */
    apiClient?: WorkerToApiContract
}

type PrewarmParams = {
    log: Logger
    apiClient: WorkerToApiContract
}

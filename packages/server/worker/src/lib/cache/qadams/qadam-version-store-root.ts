import { qadamVersionStore } from '@aiqadam/server-utils'
import { ApEnvironment, ExecutionMode, isNil, tryCatch } from '@aiqadam/shared'
import { Logger } from 'pino'
import { system, WorkerSystemProp } from '../../config/configs'

// The qadam version store root this worker hands its engines (ADR-0003, #779). The worker opens the
// store itself first, with every check `open` makes (no `node_modules` above it, a case-sensitive
// filesystem), so an engine is only ever pointed at a store that passed them; the engine then opens
// it read-only.
//
// Forked engines only. An isolate sandbox sees only what the worker mounts, and mounting the store
// needs its own design (only the official tree and the job's own platform namespace, never the
// rest; a mount point outside the sandbox's `/root`, which holds a `node_modules`). Until then an
// isolate engine gets no root and loads the image's builds, as before.
export const qadamVersionStoreRoot = {
    // Never throws: a worker without a usable store runs every step as before.
    prepare: async ({ log, environment }: PrepareParams): Promise<void> => {
        const root = system.get(WorkerSystemProp.QADAM_VERSION_STORE_PATH)
        if (isNil(root) || root.trim().length === 0) {
            preparedRoot = null
            return
        }
        const { data: opened, error } = await tryCatch(() => qadamVersionStore.open({ root, log }))
        if (error !== null) {
            preparedRoot = null
            logUnavailable({ log, environment, reason: 'the store could not be opened' })
            return
        }
        if (!opened.ok) {
            preparedRoot = null
            logUnavailable({ log, environment, reason: opened.reason })
            return
        }
        preparedRoot = opened.store.root
        log.info({}, '[qadamVersionStore] Steps in forked engines load official qadam versions from the qadam version store when it holds them')
    },

    // The variable for an engine of this execution mode, or nothing.
    engineEnv: ({ executionMode }: { executionMode: string }): Record<string, string> => {
        if (isNil(preparedRoot) || !FORKED_MODES.includes(executionMode)) {
            return {}
        }
        return { AP_QADAM_VERSION_STORE_PATH: preparedRoot }
    },
}

let preparedRoot: string | null = null

const FORKED_MODES: readonly string[] = [ExecutionMode.UNSANDBOXED, ExecutionMode.SANDBOX_CODE_ONLY]

// At info in a development tree, which usually cannot write the default under /var/lib.
function logUnavailable({ log, environment, reason }: LogUnavailableParams): void {
    const message = '[qadamVersionStore] The qadam version store is unavailable; steps load the qadams bundled with the image'
    if (environment === ApEnvironment.DEVELOPMENT) {
        log.info({ reason }, message)
        return
    }
    log.warn({ reason }, message)
}

type PrepareParams = {
    log: Logger
    environment: string | undefined
}

type LogUnavailableParams = PrepareParams & {
    reason: string
}

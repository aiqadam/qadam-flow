import { qadamVersionStoreReader } from '@aiqadam/server-utils'
import { ApEnvironment, ExecutionMode, isNil, tryCatch } from '@aiqadam/shared'
import { Logger } from 'pino'
import { system, WorkerSystemProp } from '../../config/configs'
import { readOnlyMount } from './read-only-mount'

// The qadam version store root this worker hands its engines (ADR-0003, #779).
//
// Read-only, end to end: the worker opens the store with `qadamVersionStoreReader` (no directories,
// no probe, no cleanup) and the shipped compose file mounts it read-only on workers. A forked engine
// runs flow code as the worker's user (any Code step in UNSANDBOXED), a read does not re-hash a
// version's files, and a stored version runs for every tenant on every worker across image
// upgrades, so a store a worker could write is one an engine could plant code in. Only the app
// writes the store (it seeds it, and runs `qadamVersionStore.open` with every check, the
// case-sensitivity probe included).
//
// The read-only mount is checked, not trusted (`readOnlyMount`): a store that is not on a read-only
// mount, or has a writable mount inside it, is not used outside a development environment. The
// shipped compose file is only one way to run a worker, and an older or custom one may still mount
// it read-write. Failing closed costs nothing but the store: steps load the image's builds.
//
// Forked engines only. An isolate sandbox sees only what the worker mounts, and mounting the store
// needs its own design (only the official tree and the job's own platform namespace, never the
// rest; a mount point outside the sandbox's `/root`, which holds a `node_modules`). Until then an
// isolate engine is told there is no store and loads the image's builds, as before. The store is
// still opened in every mode, so a later switch to a forked mode (picked up on reconnect) has it.
export const qadamVersionStoreRoot = {
    // Never throws: a worker without a usable store runs every step as before.
    prepare: async ({ log, environment, executionMode }: PrepareParams): Promise<void> => {
        const root = system.get(WorkerSystemProp.QADAM_VERSION_STORE_PATH)
        if (isNil(root) || root.trim().length === 0) {
            preparedRoot = null
            return
        }
        // Not by execution mode: a store opened in an isolate mode is the one a later switch to a
        // forked mode would use.
        const quiet = environment === ApEnvironment.DEVELOPMENT
        const { data: opened, error } = await tryCatch(() => qadamVersionStoreReader.open({ root }))
        if (error !== null) {
            preparedRoot = null
            logUnavailable({ log, quiet, reason: 'the store could not be opened' })
            return
        }
        if (!opened.ok) {
            preparedRoot = null
            logUnavailable({ log, quiet, reason: opened.reason })
            return
        }
        const mount = await readOnlyMount.check({ dir: opened.reader.root })
        if (!mount.readOnly) {
            const isDevelopment = environment === ApEnvironment.DEVELOPMENT
            log.warn({ reason: mount.reason, used: isDevelopment }, isDevelopment
                ? '[qadamVersionStore] The qadam version store is not on a read-only mount; mount the qadam version store read-only on workers. Used anyway in a development environment'
                : '[qadamVersionStore] The qadam version store is not on a read-only mount, so this worker does not use it; mount the qadam version store read-only on workers')
            if (!isDevelopment) {
                preparedRoot = null
                return
            }
        }
        preparedRoot = opened.reader.root
        log.info({ executionMode, usedByThisMode: qadamVersionStoreRoot.isUsedBy({ executionMode }) }, '[qadamVersionStore] Steps in forked engines load official qadam versions from the qadam version store when it holds them')
    },

    isUsedBy: ({ executionMode }: { executionMode: string | undefined }): boolean => !isNil(executionMode) && FORKED_MODES.includes(executionMode),

    // Always sets the variable, empty when this engine gets no store: an operator who lists it in
    // `AP_SANDBOX_PROPAGATED_ENV_VARS` must not hand an isolate engine a store nobody mounted for it.
    engineEnv: ({ executionMode }: { executionMode: string }): Record<string, string> => {
        const root = !isNil(preparedRoot) && qadamVersionStoreRoot.isUsedBy({ executionMode }) ? preparedRoot : ''
        return { [WorkerSystemProp.QADAM_VERSION_STORE_PATH]: root }
    },
}

let preparedRoot: string | null = null

const FORKED_MODES: readonly string[] = [ExecutionMode.UNSANDBOXED, ExecutionMode.SANDBOX_CODE_ONLY]

// At info in a development tree, which usually has no store at the default under /var/lib.
function logUnavailable({ log, quiet, reason }: LogUnavailableParams): void {
    const message = '[qadamVersionStore] The qadam version store is unavailable; steps load the qadams bundled with the image'
    if (quiet) {
        log.info({ reason }, message)
        return
    }
    log.warn({ reason }, message)
}

type PrepareParams = {
    log: Logger
    environment: string | undefined
    executionMode: string | undefined
}

type LogUnavailableParams = {
    log: Logger
    quiet: boolean
    reason: string
}

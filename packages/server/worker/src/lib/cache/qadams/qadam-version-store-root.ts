import { qadamVersionStoreReader } from '@aiqadam/server-utils'
import { ApEnvironment, ExecutionMode, isNil, tryCatch } from '@aiqadam/shared'
import { Logger } from 'pino'
import { system, WorkerSystemProp } from '../../config/configs'

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
// Forked engines only. An isolate sandbox sees only what the worker mounts, and mounting the store
// needs its own design (only the official tree and the job's own platform namespace, never the
// rest; a mount point outside the sandbox's `/root`, which holds a `node_modules`). Until then an
// isolate engine is told there is no store and loads the image's builds, as before.
export const qadamVersionStoreRoot = {
    // Never throws: a worker without a usable store runs every step as before.
    prepare: async ({ log, environment }: PrepareParams): Promise<void> => {
        const root = system.get(WorkerSystemProp.QADAM_VERSION_STORE_PATH)
        if (isNil(root) || root.trim().length === 0) {
            preparedRoot = null
            return
        }
        const { data: opened, error } = await tryCatch(() => qadamVersionStoreReader.open({ root }))
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
        preparedRoot = opened.reader.root
        log.info({}, '[qadamVersionStore] Steps in forked engines load official qadam versions from the qadam version store when it holds them')
    },

    isUsedBy: ({ executionMode }: { executionMode: string }): boolean => FORKED_MODES.includes(executionMode),

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

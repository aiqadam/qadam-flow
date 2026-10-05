import { tryCatch } from '@aiqadam/shared'
import { Logger } from 'pino'
import { spawnWithKill } from '../utils/exec'
import { getIsolateBinaryPath, isIsolateMode } from './isolate'

// Box ids are 1..AP_WORKER_CONCURRENCY for live jobs (worker.ts), so 0 is never one of them and the
// probe cannot collide with a running engine. It is in range: default.cf reserves num_boxes = 1000.
const PROBE_BOX_ID = 0
const PROBE_TIMEOUT_MS = 10_000

/**
 * #709: an isolate execution mode in an unprivileged container used to fail per job, mid-run, with
 * `Cannot run proxy, clone failed: Operation not permitted`. This probes once at worker boot instead
 * and refuses to start, so a deployment that forgot `docker-compose.sandboxed.yml` fails loudly and
 * immediately rather than on its first flow.
 */
export const isolatePreflight = {
    async assertRunnable(params: { executionMode: string, log: Logger, runProbe?: () => Promise<void> }): Promise<void> {
        const { executionMode, log, runProbe = runIsolateProbe } = params
        if (!isIsolateMode(executionMode)) {
            return
        }
        const { error } = await tryCatch(runProbe)
        if (error) {
            throw new IsolatePreflightError({ executionMode, cause: error })
        }
        log.info({ executionMode }, 'Isolate execution mode preflight passed')
    },
}

// `--init` alone only creates directories under the box root; the namespace clone that needs
// CAP_SYS_ADMIN happens when a program actually runs inside the box, so the probe must `--run`
// something. The probe uses the reserved box 0, never one a job uses (jobs take 1..concurrency), so
// it cannot disturb a running engine; it is cleaned up afterwards either way.
async function runIsolateProbe(): Promise<void> {
    const binary = getIsolateBinaryPath()
    const boxArg = `--box-id=${PROBE_BOX_ID}`
    const cleanup = async (): Promise<void> => {
        await tryCatch(() => spawnWithKill({ cmd: binary, args: [boxArg, '--cleanup'], timeoutMs: PROBE_TIMEOUT_MS }))
    }
    await cleanup()
    try {
        await spawnWithKill({ cmd: binary, args: [boxArg, '--init'], timeoutMs: PROBE_TIMEOUT_MS })
        await spawnWithKill({ cmd: binary, args: [boxArg, '--run', '--', '/bin/true'], timeoutMs: PROBE_TIMEOUT_MS })
    }
    finally {
        await cleanup()
    }
}

export class IsolatePreflightError extends Error {
    constructor({ executionMode, cause }: { executionMode: string, cause: Error }) {
        super(
            `AP_EXECUTION_MODE=${executionMode} runs the engine inside the 'isolate' sandbox, but the ` +
            `worker could not create one at startup: ${cause.message}. This mode needs CAP_SYS_ADMIN ` +
            '(and CAP_NET_ADMIN under AP_NETWORK_MODE=STRICT) plus no seccomp/AppArmor confinement — ' +
            'run the worker with the bundled docker-compose.sandboxed.yml (see ' +
            'https://flow.aiqadam.org/docs/install/architecture/sandboxing), or switch to ' +
            'UNSANDBOXED / SANDBOX_CODE_ONLY.',
            { cause },
        )
        this.name = 'IsolatePreflightError'
    }
}

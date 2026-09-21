import { FastifyInstance } from 'fastify'
import { worker } from '../../../worker/src/lib/worker'

/**
 * Shared teardown for the three CE suites that start a real worker
 * (golden-path, execute-flow-e2e, qadam-options-e2e).
 *
 * One place, not three literals: #464 raised the budget in two of the three files and #500 then
 * caught the third, so a per-file number is a guess that goes stale silently. The budget here is
 * a policy, and `runWithTimings` exists to keep it justified by measurement rather than by nerve.
 */
export const workerSuiteTeardown = {
    /** Hook budget for the shared `afterAll` below. Justified by the timings this file prints. */
    timeoutMs: 30_000,

    async run({ app }: RunParams): Promise<void> {
        const stopStartedAt = Date.now()
        await worker.stop()
        printPhase({ phase: 'worker.stop', ms: Date.now() - stopStartedAt })

        const closeStartedAt = Date.now()
        await app.close()
        printPhase({ phase: 'app.close', ms: Date.now() - closeStartedAt })
    },
}

/**
 * TEMPORARY (#500 measurement). Deliberately `process.stdout.write` rather than the app logger:
 * the suite runs with the API logger quiet, and this has to survive a hook that is about to be
 * killed at the budget, so each phase is flushed as it completes rather than summarised at the end.
 */
function printPhase({ phase, ms }: PrintPhaseParams): void {
    process.stdout.write(`[teardown-timing] ${phase} ${ms}ms\n`)
}

type RunParams = {
    app: FastifyInstance
}

type PrintPhaseParams = {
    phase: string
    ms: number
}

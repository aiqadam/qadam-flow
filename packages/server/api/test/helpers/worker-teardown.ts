import { FastifyInstance } from 'fastify'
import { worker } from '../../../worker/src/lib/worker'

/** Comfortably inside the 30s budget, so the dump lands before vitest kills the hook. */
const WATCHDOG_AT_MS = 22_000

let inFlightPhase: string | null = null

/**
 * Shared teardown for the three CE suites that start a real worker
 * (golden-path, execute-flow-e2e, qadam-options-e2e).
 *
 * One place, not three literals: #464 raised the budget in two of the three files and #500 then
 * caught the third, so a per-file number is a guess that goes stale silently. The budget here is
 * a policy, and the timings this file prints are what justifies it.
 */
export const workerSuiteTeardown = {
    /** Hook budget for the shared `afterAll` below. Justified by the timings this file prints. */
    timeoutMs: 30_000,

    async run({ app }: RunParams): Promise<void> {
        const watchdog = startWatchdog()
        try {
            await timePhase({ phase: 'worker.stop', run: () => worker.stop() })
            await timePhase({ phase: 'app.close', run: () => app.close() })
        }
        finally {
            clearTimeout(watchdog)
        }
    },
}

/**
 * TEMPORARY (#500 measurement). Deliberately `process.stdout.write` rather than the app logger:
 * the suite runs with the API logger quiet, and this has to survive a hook that is about to be
 * killed at the budget, so each phase is flushed as it starts and again as it completes rather
 * than summarised at the end.
 */
async function timePhase({ phase, run }: TimePhaseParams): Promise<void> {
    process.stdout.write(`[teardown-timing] ${phase} START\n`)
    inFlightPhase = phase
    const startedAt = Date.now()
    await run()
    inFlightPhase = null
    process.stdout.write(`[teardown-timing] ${phase} ${Date.now() - startedAt}ms\n`)
}

/**
 * TEMPORARY (#500 measurement). The run that matters is the one vitest kills at the budget, and a
 * killed hook prints no completion line at all — so the only way to learn anything from a failing
 * run is to report, from outside the awaits, which phase was still in flight and what the event
 * loop was holding open when it stalled.
 */
function startWatchdog(): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
        const resources = process.getActiveResourcesInfo()
        const counted = resources.reduce<Record<string, number>>(
            (acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }),
            {},
        )
        process.stdout.write(
            `[teardown-timing] WATCHDOG stalled in ${inFlightPhase ?? 'nothing'} — active resources: ${JSON.stringify(counted)}\n`,
        )
    }, WATCHDOG_AT_MS)
    timer.unref()
    return timer
}

type RunParams = {
    app: FastifyInstance
}

type TimePhaseParams = {
    phase: string
    run: () => Promise<void>
}

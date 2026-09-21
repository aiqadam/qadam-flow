import { FastifyInstance } from 'fastify'
import { worker } from '../../../worker/src/lib/worker'

/**
 * Shared teardown for the three CE suites that start a real worker
 * (golden-path, execute-flow-e2e, qadam-options-e2e).
 *
 * One place, not three literals: #464 raised the budget in two of the three files and #500 then
 * caught the third, so a per-file number is three guesses that drift apart silently.
 */
export const workerSuiteTeardown = {
    /**
     * Measured, not guessed. With the runs-metadata re-enqueue loop fixed (#500), the whole
     * teardown costs 12-30ms across 12 samples under the full 71-file serial suite — the worst
     * single step, `runsMetadataWorker.close()`, is 0-2ms. Before that fix the same step ranged to
     * 29476ms against the 30000ms this replaces, which is why the suites failed about one run in
     * three while every test in them passed.
     *
     * 15s is therefore ~500x the measured cost and still small enough to fail fast: a regression of
     * the class #500 was, where one close stalls for 20s+, trips this instead of hiding inside a
     * budget it can fit in. Note vitest's own `hookTimeout` is 60s (vitest.config.ts), so this is a
     * tightening, not a relaxation — raising it past 60s would do nothing.
     *
     * The floor is not the 12-30ms, though: `worker.stop()` waits up to POLL_LOOP_SHUTDOWN_GRACE_MS
     * (5s) for a poll loop that is mid-job, so the worst case this code can produce is ~5s plus
     * `app.close()`. 15s is ~3x that, not ~500x — which is the number to reason from if anyone
     * lowers this further.
     *
     * If this starts failing, measure which phase grew before touching the number. #464 raised
     * 15s to 30s without measuring and the same failure returned within one suite's worth of
     * growth.
     */
    timeoutMs: 15_000,

    async run({ app }: RunParams): Promise<void> {
        await worker.stop()
        await app.close()
    },
}

type RunParams = {
    app: FastifyInstance
}

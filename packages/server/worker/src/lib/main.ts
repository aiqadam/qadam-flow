import { eventLoopMonitor } from '@aiqadam/server-utils'
import { deleteStaleCache } from './cache/cache-paths'
import { getApiUrl, getSocketUrl, system, WorkerSystemProp } from './config/configs'
import { logger } from './config/logger'
import { worker } from './worker'

const workerToken = system.getOrThrow(WorkerSystemProp.WORKER_TOKEN)

/** Room for what `stop()` does after the drain: sandbox, socket and egress teardown. */
const FORCED_EXIT_MARGIN_MS = 15_000

// Exported rather than invoked here: `src/index.ts` is the entry point that runs it. A call at
// module scope can be neither awaited nor cancelled, so a test that imported this module leaked
// one in-flight start into the next test (#823).
export async function main(): Promise<void> {
    const containerType = system.getContainerType()

    // Fire-and-forget: a stale-cache cleanup failure must never block a worker from
    // starting to accept jobs. Errors are logged inside deleteStaleCache itself.
    void deleteStaleCache()

    await worker.start({ apiUrl: getApiUrl(), socketUrl: getSocketUrl(), workerToken, withHealthServer: containerType === 'WORKER' })
    // The worker relays every engine RPC to the API, so a stall here reads as a slow step (#587).
    const loopMonitor = eventLoopMonitor.start({ log: logger })

    const shutdown = async () => {
        // Past the drain `worker.stop()` is allowed, not inside it: a forced exit that fires first
        // kills the very jobs the drain is waiting for (#585).
        const timeout = setTimeout(() => {
            logger.warn('Graceful shutdown timed out, forcing exit')
            process.exit(1)
        }, system.getShutdownGraceMs() + FORCED_EXIT_MARGIN_MS)
        loopMonitor.stop()
        await worker.stop()
        clearTimeout(timeout)
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
}

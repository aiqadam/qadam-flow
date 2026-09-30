import { eventLoopMonitor } from '@aiqadam/server-utils'
import { deleteStaleCache } from './cache/cache-paths'
import { getApiUrl, getSocketUrl, system, WorkerSystemProp } from './config/configs'
import { logger } from './config/logger'
import { worker } from './worker'

const workerToken = system.getOrThrow(WorkerSystemProp.WORKER_TOKEN)

async function main(): Promise<void> {
    const containerType = system.getContainerType()

    // Fire-and-forget: a stale-cache cleanup failure must never block a worker from
    // starting to accept jobs. Errors are logged inside deleteStaleCache itself.
    void deleteStaleCache()

    await worker.start({ apiUrl: getApiUrl(), socketUrl: getSocketUrl(), workerToken, withHealthServer: containerType === 'WORKER' })
    // The worker relays every engine RPC to the API, so a stall here reads as a slow step (#587).
    const loopMonitor = eventLoopMonitor.start({ log: logger })

    const shutdown = async () => {
        const timeout = setTimeout(() => {
            logger.warn('Graceful shutdown timed out, forcing exit')
            process.exit(1)
        }, 30_000)
        loopMonitor.stop()
        await worker.stop()
        clearTimeout(timeout)
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
    logger.error({ error: err }, 'Worker crashed')
    process.exit(1)
})


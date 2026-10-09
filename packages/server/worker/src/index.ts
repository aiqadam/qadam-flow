import './lib/instrumentation'
import { logger } from './lib/config/logger'
import { main } from './lib/main'

main().catch((err: unknown) => {
    // `err`, not `error`: pino serializes an Error (message, stack) and applies the `err.*` redact
    // paths only under that key. Exiting at once loses no line: the default destination writes
    // synchronously, and pino flushes a LOG_PRETTY transport's worker thread on process exit.
    logger.error({ err }, 'Worker crashed')
    process.exit(1)
})

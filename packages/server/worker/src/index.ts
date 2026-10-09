import './lib/instrumentation'
import { logger } from './lib/config/logger'
import { main } from './lib/main'

main().catch((err) => {
    logger.error({ error: err }, 'Worker crashed')
    process.exit(1)
})

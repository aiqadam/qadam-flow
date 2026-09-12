import { FastifyInstance } from 'fastify'
import { accessTokenManager } from '../../src/app/authentication/lib/access-token-manager'
import { migrateQueuesAndRunConsumers } from '../../src/app/workers/worker-module'
import { setupTestEnvironment } from './test-setup'

export type E2eContext = {
    app: FastifyInstance
    workerToken: string
    apiUrl: string
}

export async function setupE2eEnvironment(): Promise<E2eContext> {
    // Use port 0 so the OS assigns a free port, avoiding EADDRINUSE in parallel test runs.
    const app = await setupTestEnvironment({ fresh: true })
    await app.listen({ port: 0, host: '127.0.0.1' })

    const address = app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 3000
    const apiUrl = `http://127.0.0.1:${port}`

    process.env.AP_FRONTEND_URL = apiUrl
    process.env.AP_API_URL = apiUrl
    process.env.AP_PORT = String(port)
    // .env.tests pins AP_INTERNAL_URL to a fixed dev-stack port that this
    // harness's dynamically-bound listener never matches — override it here
    // the same way AP_FRONTEND_URL/AP_PORT are overridden above, so a
    // same-process call built from AppSystemProp.INTERNAL_URL (e.g. a
    // queue-mode callFlow wait-for-response resume) targets the real port.
    process.env.AP_INTERNAL_URL = apiUrl

    await migrateQueuesAndRunConsumers(app)

    const workerToken = await accessTokenManager(app.log).generateWorkerToken()

    return { app, workerToken, apiUrl }
}

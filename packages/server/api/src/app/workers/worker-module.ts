import { FastifyInstance } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { runsMetadataQueue } from '../flows/flow-run/flow-runs-queue'
import { pubsub } from '../helper/pubsub'
import { flowEngineWorker } from './engine-controller'
import { setupBullMQBoard } from './job-queue/bullboard'
import { jobBroker } from './job-queue/job-broker'
import { jobQueue } from './job-queue/job-queue'
import { workerMachineController } from './machine/machine-controller'
import { queueMigration } from './migrations/queue-migration-runner'
export const workerModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(flowEngineWorker, {
        prefix: '/v1/engine',
    })
    await app.register(workerMachineController, {
        prefix: '/v1/worker-machines',
    })
    await jobQueue(app.log).init()

    await runsMetadataQueue(app.log).init()

    await setupBullMQBoard(app)

    app.addHook('onClose', async () => {
        await timeCloseStep({ step: 'jobBroker.close', run: () => jobBroker(app.log).close() })
        await timeCloseStep({ step: 'runsMetadataQueue.close', run: () => runsMetadataQueue(app.log).close() })
        await timeCloseStep({ step: 'jobQueue.close', run: () => jobQueue(app.log).close() })
        await timeCloseStep({ step: 'pubsub.close', run: () => pubsub.close() })
    })
}


/** TEMPORARY (#500 measurement): which `onClose` hook consumes the CE suites' teardown budget. */
async function timeCloseStep({ step, run }: { step: string, run: () => Promise<void> }): Promise<void> {
    const startedAt = Date.now()
    await run()
    process.stdout.write(`[teardown-timing] app.close/${step} ${Date.now() - startedAt}ms\n`)
}

// This should be called after the app is booted, to ensure no plugin timeout
export const migrateQueuesAndRunConsumers = async (app: FastifyInstance) => {
    await queueMigration(app.log).run()
    await jobBroker(app.log).init()
}

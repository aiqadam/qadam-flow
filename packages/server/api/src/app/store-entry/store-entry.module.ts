import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
    entitiesMustBeOwnedByCurrentProject,
} from '../authentication/authorization'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { storeEntryController } from './store-entry.controller'
import { storeEntryService } from './store-entry.service'

// Expiry is enforced on read too, so a missed sweep is never a correctness problem —
// but without the sweep the dedup-key use case, which is what TTL is mostly for,
// grows store-entry without bound.
const CLEANUP_BATCH_SIZE = 1000

export const storeEntryModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)
    systemJobHandlers.registerJobHandler(SystemJobName.STORE_ENTRY_CLEANUP, async () => {
        // Bounded per run rather than one unbounded DELETE: a large backlog must not
        // hold a lock over the whole table.
        let deleted = 0
        do {
            deleted = await storeEntryService.deleteExpired({ limit: CLEANUP_BATCH_SIZE })
        } while (deleted === CLEANUP_BATCH_SIZE)
    })
    await systemJobsSchedule(app.log).upsertJob({
        job: {
            name: SystemJobName.STORE_ENTRY_CLEANUP,
            data: {},
            jobId: SystemJobName.STORE_ENTRY_CLEANUP,
        },
        schedule: {
            type: 'repeated',
            cron: '17 */1 * * *',
        },
    })
    await app.register(storeEntryController, { prefix: '/v1/store-entries' })
}

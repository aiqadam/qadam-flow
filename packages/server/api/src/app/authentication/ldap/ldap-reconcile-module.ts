import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { SystemJobName } from '../../helper/system-jobs/common'
import { systemJobHandlers } from '../../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../../helper/system-jobs/system-job'
import { ldapReconcileService } from './ldap-reconcile-service'

// Registered unconditionally, even when reconcile is disabled — the job scheduler always has a
// tick to fire, and `reconcileAllPlatforms` itself re-reads `LDAP_RECONCILE_ENABLED` on every tick
// and no-ops when it's off. That makes toggling the flag take effect on the very next scheduled
// run, rather than needing the BullMQ repeatable job removed and re-added by a restart.
export const ldapReconcileModule: FastifyPluginAsyncZod = async (app) => {
    systemJobHandlers.registerJobHandler(SystemJobName.LDAP_RECONCILE, async () => {
        await ldapReconcileService(app.log).reconcileAllPlatforms()
    })
    await systemJobsSchedule(app.log).upsertJob({
        job: {
            name: SystemJobName.LDAP_RECONCILE,
            data: {},
            jobId: SystemJobName.LDAP_RECONCILE,
        },
        schedule: {
            type: 'repeated',
            cron: system.get(AppSystemProp.LDAP_RECONCILE_CRON) ?? '23 * * * *',
        },
    })
}

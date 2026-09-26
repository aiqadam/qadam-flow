import { isNil, tryCatchSync } from '@aiqadam/shared'
import { parseExpression } from 'cron-parser'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { SystemJobName } from '../../helper/system-jobs/common'
import { systemJobHandlers } from '../../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../../helper/system-jobs/system-job'
import { ldapReconcileService } from './ldap-reconcile-service'

export const ldapReconcileModuleUtils = {
    resolveReconcileCron,
}

const DEFAULT_RECONCILE_CRON = '23 * * * *'

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
            cron: resolveReconcileCron(app.log),
        },
    })
}

// BullMQ's own repeat-pattern parsing (`cron-parser` internally) throws synchronously when the
// job is scheduled — an operator's malformed `LDAP_RECONCILE_CRON` must never be allowed to crash
// server boot over a background job's own schedule. Falling back to the default and logging is
// the safe direction; the alternative (throwing) would take the *entire* server down for a typo
// in one optional feature's cron string.
function resolveReconcileCron(log: FastifyBaseLogger): string {
    const configured = system.get(AppSystemProp.LDAP_RECONCILE_CRON)
    if (isNil(configured) || configured === '') {
        return DEFAULT_RECONCILE_CRON
    }
    const { error } = tryCatchSync(() => parseExpression(configured))
    if (!isNil(error)) {
        log.error({ err: error, configured }, `[ldapReconcileModule] LDAP_RECONCILE_CRON is not a valid cron expression; falling back to the default (${DEFAULT_RECONCILE_CRON})`)
        return DEFAULT_RECONCILE_CRON
    }
    return configured
}

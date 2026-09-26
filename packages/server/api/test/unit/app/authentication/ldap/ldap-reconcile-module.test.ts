import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ldapReconcileModuleUtils } from '../../../../../src/app/authentication/ldap/ldap-reconcile-module'
import { system } from '../../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../../src/app/helper/system/system-props'

const DEFAULT_RECONCILE_CRON = '23 * * * *'

afterEach(() => {
    vi.restoreAllMocks()
})

// BullMQ's own cron parsing throws synchronously at schedule time — an operator's malformed
// `LDAP_RECONCILE_CRON` must fall back to the default and log an error, never crash server boot
// over one optional feature's schedule string.
describe('ldapReconcileModuleUtils.resolveReconcileCron', () => {
    it('falls back to the default when LDAP_RECONCILE_CRON is unset', () => {
        vi.spyOn(system, 'get').mockReturnValue(undefined)
        const log = pino({ level: 'silent' })

        expect(ldapReconcileModuleUtils.resolveReconcileCron(log)).toBe(DEFAULT_RECONCILE_CRON)
        expect(system.get).toHaveBeenCalledWith(AppSystemProp.LDAP_RECONCILE_CRON)
    })

    it('falls back to the default when LDAP_RECONCILE_CRON is an empty string', () => {
        vi.spyOn(system, 'get').mockReturnValue('')
        const log = pino({ level: 'silent' })

        expect(ldapReconcileModuleUtils.resolveReconcileCron(log)).toBe(DEFAULT_RECONCILE_CRON)
    })

    it('passes through a valid configured cron expression unchanged', () => {
        vi.spyOn(system, 'get').mockReturnValue('*/15 * * * *')
        const log = pino({ level: 'silent' })

        expect(ldapReconcileModuleUtils.resolveReconcileCron(log)).toBe('*/15 * * * *')
    })

    it('falls back to the default and logs an error when LDAP_RECONCILE_CRON is not a valid cron expression', () => {
        vi.spyOn(system, 'get').mockReturnValue('not-a-cron-expression')
        const log = pino({ level: 'silent' })
        const errorSpy = vi.spyOn(log, 'error')

        const resolved = ldapReconcileModuleUtils.resolveReconcileCron(log)

        expect(resolved).toBe(DEFAULT_RECONCILE_CRON)
        expect(errorSpy).toHaveBeenCalledTimes(1)
    })
})

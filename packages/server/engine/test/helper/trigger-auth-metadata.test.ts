import { TriggerHookType } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { triggerHelperInternals } from '../../src/lib/helper/trigger-helper'

const { authMetadataModeFor } = triggerHelperInternals

/**
 * Reading the connection's `metadata` costs an uncached fetch of the *decrypted* connection from
 * inside the sandbox. `RUN` is the hot path for every inbound webhook event and every polling tick
 * of every connection-backed trigger in the product, and it never looks at the value — so this
 * decides a product-wide cost, not a Telegram detail. It regressed once because nothing asserted it.
 */
describe('authMetadataModeFor', () => {
    it('does not read it on the hook that runs per event', () => {
        expect(authMetadataModeFor(TriggerHookType.RUN)).toBeUndefined()
    })

    it.each([TriggerHookType.HANDSHAKE, TriggerHookType.TEST, TriggerHookType.RENEW])(
        'does not read it on %s either',
        (hookType) => {
            expect(authMetadataModeFor(hookType)).toBeUndefined()
        },
    )

    // Getting the transport wrong here registers a webhook on a connection that asked to be polled,
    // so a failed read must stop the enable rather than fall back to the default transport.
    it('requires it when enabling', () => {
        expect(authMetadataModeFor(TriggerHookType.ON_ENABLE)).toBe('required')
    })

    // The other direction leaves at worst an orphaned subscription, and refusing would leave a flow
    // that cannot be switched off.
    it('tolerates a failed read when disabling', () => {
        expect(authMetadataModeFor(TriggerHookType.ON_DISABLE)).toBe('best-effort')
    })
})

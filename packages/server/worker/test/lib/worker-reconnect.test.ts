import { describe, expect, it } from 'vitest'
import { needsManualReconnect } from '../../src/lib/worker'

describe('needsManualReconnect', () => {
    // socket.io reconnects by itself for transport-level drops. The one reason it does not is the
    // server closing the connection — which is what a graceful API shutdown looks like, and what
    // left every worker permanently idle after an API restart.
    it('reconnects when the server closed the connection', () => {
        expect(needsManualReconnect('io server disconnect')).toBe(true)
    })

    it('does not fight our own shutdown', () => {
        expect(needsManualReconnect('io client disconnect')).toBe(false)
    })

    it('leaves transport-level drops to socket.io, which already retries them', () => {
        for (const reason of ['transport close', 'transport error', 'ping timeout', 'parse error']) {
            expect(needsManualReconnect(reason)).toBe(false)
        }
    })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leaseTracker } from '../../src/lib/lease-tracker'

/** The API's lock lifetime per renewal (`LOCK_DURATION_MS` in job-broker.ts). */
const LOCK_MS = 120_000

describe('leaseTracker (#585)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('gives a renewed lease up at least one renewal interval before the lock that renewal bought expires', async () => {
        const expired: { token: string, leaseAgeMs: number }[] = []
        const tracker = leaseTracker.create({ onExpired: (lease) => expired.push(lease) })
        tracker.track({ token: 't1' })

        await vi.advanceTimersByTimeAsync(leaseTracker.renewalIntervalMs)
        const sentAt = tracker.now()
        // The API extended the lock no earlier than the send, so it expires no earlier than this.
        const lockExpiresAt = sentAt + LOCK_MS
        // A slow answer: confirmed 20 s after it was sent.
        await vi.advanceTimersByTimeAsync(20_000)
        tracker.confirm({ token: 't1', sentAt })

        await vi.advanceTimersByTimeAsync(lockExpiresAt - tracker.now())
        expect(expired).toHaveLength(1)
        const givenUpAt = sentAt + expired[0].leaseAgeMs
        expect(lockExpiresAt - givenUpAt).toBeGreaterThanOrEqual(leaseTracker.renewalIntervalMs)
    })

    it('gives up a lease never renewed after the poll that handed it out', async () => {
        const onExpired = vi.fn()
        const tracker = leaseTracker.create({ onExpired })
        tracker.track({ token: 't1' })

        await vi.advanceTimersByTimeAsync(leaseTracker.trustMs - 1)
        expect(onExpired).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(onExpired).toHaveBeenCalledWith({ token: 't1', leaseAgeMs: leaseTracker.trustMs })
    })

    it('keeps a lease that is renewed on time', async () => {
        const onExpired = vi.fn()
        const tracker = leaseTracker.create({ onExpired })
        tracker.track({ token: 't1' })

        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(leaseTracker.renewalIntervalMs)
            tracker.confirm({ token: 't1', sentAt: tracker.now() })
        }

        expect(onExpired).not.toHaveBeenCalled()
        expect(tracker.ageMs({ token: 't1' })).toBe(0)
    })

    it('does not let the answer to an older renewal move the deadline back', async () => {
        const onExpired = vi.fn()
        const tracker = leaseTracker.create({ onExpired })
        tracker.track({ token: 't1' })
        await vi.advanceTimersByTimeAsync(10_000)
        const olderSentAt = tracker.now()
        await vi.advanceTimersByTimeAsync(20_000)
        tracker.confirm({ token: 't1', sentAt: tracker.now() })

        tracker.confirm({ token: 't1', sentAt: olderSentAt })

        expect(tracker.ageMs({ token: 't1' })).toBe(0)
    })

    it('ignores a confirmation for a lease that already expired or was forgotten', async () => {
        const onExpired = vi.fn()
        const tracker = leaseTracker.create({ onExpired })
        tracker.track({ token: 'expired' })
        tracker.track({ token: 'forgotten' })
        tracker.forget({ token: 'forgotten' })
        await vi.advanceTimersByTimeAsync(leaseTracker.trustMs)

        tracker.confirm({ token: 'expired', sentAt: tracker.now() })
        tracker.confirm({ token: 'forgotten', sentAt: tracker.now() })
        await vi.advanceTimersByTimeAsync(leaseTracker.trustMs)

        expect(onExpired).toHaveBeenCalledTimes(1)
        expect(onExpired).toHaveBeenCalledWith(expect.objectContaining({ token: 'expired' }))
        expect(tracker.ageMs({ token: 'expired' })).toBeNull()
        expect(tracker.ageMs({ token: 'forgotten' })).toBeNull()
    })
})

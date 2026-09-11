import { describe, expect, it } from 'vitest'
import { longPollingTiming } from '../../../../../src/app/trigger/long-polling/long-polling-host'

const { nextBackoff, MIN_BACKOFF_MS, MAX_BACKOFF_MS, MAX_REQUESTED_BACKOFF_MS } = longPollingTiming

describe('nextBackoff', () => {
    it('starts at the minimum rather than at zero', () => {
        expect(nextBackoff({ backoffMs: 0 })).toBe(MIN_BACKOFF_MS)
    })

    it('doubles, then stops at the ceiling', () => {
        expect(nextBackoff({ backoffMs: MIN_BACKOFF_MS })).toBe(MIN_BACKOFF_MS * 2)
        expect(nextBackoff({ backoffMs: MAX_BACKOFF_MS })).toBe(MAX_BACKOFF_MS)
    })

    // A value the third party asked for is a floor, not a suggestion: capping it at the host's own
    // ceiling would just earn another rate-limit response on the next window.
    it('honours a requested delay above its own ceiling', () => {
        const requested = MAX_BACKOFF_MS / 1000 + 60

        expect(nextBackoff({ backoffMs: 0, retryAfterSeconds: requested })).toBe(requested * 1000)
    })

    it('still prefers its own backoff when that is the larger of the two', () => {
        expect(nextBackoff({ backoffMs: 60_000, retryAfterSeconds: 1 })).toBe(120_000)
    })

    // Above 2^31-1 ms setTimeout fires after 1ms, which would turn the longest wait into the shortest.
    it('clamps an absurd requested delay instead of letting setTimeout invert it', () => {
        const clamped = nextBackoff({ backoffMs: 0, retryAfterSeconds: 60 * 60 * 24 * 365 })

        expect(clamped).toBe(MAX_REQUESTED_BACKOFF_MS)
        expect(clamped).toBeLessThan(2 ** 31 - 1)
    })
})

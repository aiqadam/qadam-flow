import { isNil, WORKER_JOB_LOCK_DURATION_MS } from '@aiqadam/shared'

/** How often a running job renews its lease. */
const RENEWAL_INTERVAL_MS = 30_000

/**
 * A lease is given up this long after the send of its last confirmed renewal, so one renewal
 * interval before the lock that renewal bought can expire. Past expiry the API's stalled scan may
 * hand the job to another worker, and two engines would run it (#585); the margin absorbs a late
 * timer and a clock that is not the API's.
 */
const TRUST_MS = WORKER_JOB_LOCK_DURATION_MS - RENEWAL_INTERVAL_MS

/**
 * When each in-flight job's lease was last confirmed, and a one-shot deadline per lease that fires
 * once it has gone `TRUST_MS` without a confirmation. A confirmation is stamped with the time its
 * renewal was *sent*: the API extended the lock at or after that moment, never before, so a slow
 * answer cannot make a lease look fresher than its lock is. Monotonic time, so a wall-clock step
 * cannot move a deadline either way.
 */
export const leaseTracker = {
    renewalIntervalMs: RENEWAL_INTERVAL_MS,
    trustMs: TRUST_MS,
    create({ onExpired }: CreateParams): LeaseTracker {
        const leases = new Map<string, Lease>()

        function arm({ token, confirmedAt }: ArmParams): void {
            const previous = leases.get(token)
            if (!isNil(previous)) {
                // The answer to an older renewal, overtaken by a newer one.
                if (confirmedAt <= previous.confirmedAt) {
                    return
                }
                clearTimeout(previous.deadline)
            }
            const deadline = setTimeout(() => {
                leases.delete(token)
                onExpired({ token, leaseAgeMs: Math.round(performance.now() - confirmedAt) })
            }, Math.max(0, confirmedAt + TRUST_MS - performance.now()))
            deadline.unref?.()
            leases.set(token, { confirmedAt, deadline })
        }

        return {
            track({ token }) {
                arm({ token, confirmedAt: performance.now() })
            },
            now: () => performance.now(),
            confirm({ token, sentAt }) {
                // A lease already expired or forgotten stays that way: the job is no longer ours.
                if (leases.has(token)) {
                    arm({ token, confirmedAt: sentAt })
                }
            },
            forget({ token }) {
                const lease = leases.get(token)
                if (!isNil(lease)) {
                    clearTimeout(lease.deadline)
                    leases.delete(token)
                }
            },
            ageMs({ token }) {
                const lease = leases.get(token)
                return isNil(lease) ? null : Math.round(performance.now() - lease.confirmedAt)
            },
        }
    },
}

type CreateParams = {
    onExpired: (params: { token: string, leaseAgeMs: number }) => void
}

type ArmParams = {
    token: string
    confirmedAt: number
}

type Lease = {
    confirmedAt: number
    deadline: ReturnType<typeof setTimeout>
}

export type LeaseTracker = {
    /** Starts a lease confirmed now: the poll that handed the job out took its lock. */
    track(params: { token: string }): void
    /** The clock confirmations are stamped with; read it just before sending a renewal. */
    now(): number
    confirm(params: { token: string, sentAt: number }): void
    forget(params: { token: string }): void
    ageMs(params: { token: string }): number | null
}

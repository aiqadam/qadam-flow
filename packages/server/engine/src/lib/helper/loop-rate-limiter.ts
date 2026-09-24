import { setTimeout as sleep } from 'node:timers/promises'
import { isNil, LoopExecutionSettings } from '@aiqadam/shared'

const MAX_TIMER_MS = 2_147_483_647

// One per running loop (#387). Iterations start at most `count` per `perSeconds`, spaced evenly
// rather than in bursts — a provider's per-second ceiling is what the spacing protects. A
// provider's own `retry_after` pauses every iteration of the loop, not only the one it answered:
// that is the difference between one governed queue and a stampede of 429s.
export const loopRateLimiter = {
    create({ rateLimit }: { rateLimit: LoopExecutionSettings['rateLimit'] }): LoopRateLimiter {
        const intervalMs = isNil(rateLimit) ? 0 : (rateLimit.perSeconds * 1000) / rateLimit.count
        let nextStartAt = 0
        let pausedUntil = 0
        return {
            // Called by the loop's single dispatcher, so a slot is reserved only when it is taken,
            // and a pause that arrives while it waits is still honoured.
            async acquire(): Promise<void> {
                for (;;) {
                    const now = Date.now()
                    const startAt = Math.max(now, nextStartAt, pausedUntil)
                    if (startAt <= now) {
                        nextStartAt = now + intervalMs
                        return
                    }
                    // Node clamps a longer timer to 1 ms and warns on every wake-up.
                    await sleep(Math.min(startAt - now, MAX_TIMER_MS))
                }
            },
            pause({ seconds }: { seconds: number }): void {
                pausedUntil = Math.max(pausedUntil, Date.now() + seconds * 1000)
            },
            msUntilNextStart(): number {
                return Math.max(0, Math.max(nextStartAt, pausedUntil) - Date.now())
            },
        }
    },
}

export type LoopRateLimiter = {
    acquire(): Promise<void>
    pause(params: { seconds: number }): void
    msUntilNextStart(): number
}

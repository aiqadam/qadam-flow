import { describe, expect, it } from 'vitest'
import { longPollingCapacity } from '../../../../../src/app/trigger/long-polling/long-polling-capacity'

const { shareFor, MAX_CONCURRENT_TASKS, MIN_CONCURRENT_TASKS_PER_PROJECT } = longPollingCapacity

/**
 * Each pull task holds an HTTP request open to a third party for its whole window, so the ceiling
 * is a real resource bound. The share below it exists because a running task is never displaced:
 * whichever project fills the instance first would otherwise keep every slot for good.
 */
describe('long-polling capacity share', () => {
    // Qadam Flow is self-hosted by design. A fixed per-project constant would cap the single-project
    // install — the one the install script produces — at that constant instead of its whole instance.
    it('gives a lone project nearly the whole instance', () => {
        expect(shareFor({ projectsWanting: 1 })).toBeGreaterThanOrEqual(MAX_CONCURRENT_TASKS - MIN_CONCURRENT_TASKS_PER_PROJECT)
    })

    // The guarantee: a project arriving at a full instance always finds room, because no single
    // project was ever allowed to hold the last slots. Division alone does not give this — by the
    // time the second project appears, the first one's tasks are already running.
    it('never lets one project hold the last slots, however few projects are competing', () => {
        for (const projectsWanting of [1, 2, 3, 8]) {
            expect(shareFor({ projectsWanting })).toBeLessThanOrEqual(MAX_CONCURRENT_TASKS - MIN_CONCURRENT_TASKS_PER_PROJECT)
        }
    })

    it('splits the instance as more projects want to poll', () => {
        expect(shareFor({ projectsWanting: 4 })).toBeLessThan(shareFor({ projectsWanting: 2 }))
    })

    // Otherwise a busy instance would starve everyone equally instead of serving some flows.
    it('never divides a project below the floor, however many are competing', () => {
        expect(shareFor({ projectsWanting: 1_000 })).toBe(MIN_CONCURRENT_TASKS_PER_PROJECT)
    })

    // `desired` is empty on an install with no pull flows at all, and the arithmetic runs anyway.
    it('does not produce a nonsense share when nothing wants to poll', () => {
        expect(Number.isFinite(shareFor({ projectsWanting: 0 }))).toBe(true)
    })
})

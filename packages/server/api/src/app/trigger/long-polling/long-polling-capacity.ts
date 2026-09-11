/**
 * How many pull loops one instance runs, and how they are shared between projects.
 *
 * Each task holds an HTTP request open to a third party for its whole window, so the ceiling is a
 * real resource bound rather than a throughput knob. The long-polling flag is on by default, so
 * without a ceiling a platform could be talked into unbounded open sockets simply by enabling flows.
 *
 * Constants rather than settings: nobody can pick these numbers without measuring, and an install
 * that hits them has a capacity problem an env var would only hide.
 */
const MAX_CONCURRENT_TASKS = 200
/** Nobody's share drops below this, however many projects are competing. */
const MIN_CONCURRENT_TASKS_PER_PROJECT = 25
/** Held back from any one project, so a project that shows up late is never locked out. */
const RESERVED_FOR_LATE_ARRIVALS = MIN_CONCURRENT_TASKS_PER_PROJECT

/**
 * The share exists because the global ceiling is first-come and a running task is never displaced:
 * without it, whichever project fills the instance first keeps every slot, and every other project
 * is refused on every sync from then on rather than transiently.
 *
 * Two properties, and it is worth being exact about which is guaranteed:
 *
 * - **Guaranteed.** No single project may hold the last `RESERVED_FOR_LATE_ARRIVALS` slots, so a
 *   project arriving at a full instance always finds room. A share computed only by division does
 *   *not* give this — by the time a second project appears, the first one's tasks are already
 *   running and nothing takes them back.
 * - **Best effort.** Dividing by the number of projects currently wanting to poll keeps the split
 *   roughly even as projects come and go. It cannot rebalance retroactively.
 *
 * Division alone would also be wrong for the deployment this project is built for: Qadam Flow is
 * self-hosted by design, and a fixed constant would cap a single-project install at that constant
 * instead of its whole instance.
 */
function shareFor({ projectsWanting }: ShareForParams): number {
    const evenSplit = Math.floor(MAX_CONCURRENT_TASKS / Math.max(1, projectsWanting))
    return Math.min(
        Math.max(MIN_CONCURRENT_TASKS_PER_PROJECT, evenSplit),
        MAX_CONCURRENT_TASKS - RESERVED_FOR_LATE_ARRIVALS,
    )
}

export const longPollingCapacity = {
    shareFor,
    MAX_CONCURRENT_TASKS,
    MIN_CONCURRENT_TASKS_PER_PROJECT,
}

type ShareForParams = {
    projectsWanting: number
}

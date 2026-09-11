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
 * Be exact about what this does and does not buy, because a reserve is easy to over-read:
 *
 * - **Guaranteed.** No *single* project can occupy the whole instance, so a **second** project
 *   always finds at least `RESERVED_FOR_LATE_ARRIVALS` slots waiting for it. Division alone does not
 *   give even this — by the time the second project appears, the first one's tasks are running and
 *   nothing takes them back.
 * - **Best effort.** Dividing by the number of projects currently wanting to poll keeps the split
 *   roughly even as projects come and go.
 * - **Not provided.** Fairness for the *third* project onward. Once two projects between them fill
 *   the instance, an arrival is refused on every sync until a task exits, because a running task is
 *   never displaced. With the floor that is reachable at eight projects (8 x 25), which is a
 *   plausible platform rather than a pathological one. Closing it means reclaiming live tasks from
 *   an over-share project, which costs a delivery gap on a working flow — a trade worth making
 *   deliberately, with a measurement, rather than inside a fix for something else.
 *
 * Division alone would also be wrong for the deployment this project is built for: Qadam Flow is
 * self-hosted by design, and a fixed constant would cap a single-project install at that constant.
 * Such an install does not get the whole instance either — it gets `MAX - RESERVED`, which is what
 * the guarantee above costs it.
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
    RESERVED_FOR_LATE_ARRIVALS,
}

type ShareForParams = {
    projectsWanting: number
}

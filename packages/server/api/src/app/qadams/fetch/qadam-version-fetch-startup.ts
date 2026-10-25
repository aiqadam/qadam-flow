import { FlowVersion, FlowVersionState, isNil, ProjectId, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { distributedLock } from '../../database/redis-connections'
import { flowRepo } from '../../flows/flow/flow.repo'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { platformService } from '../../platform/platform.service'
import { projectService } from '../../project/project-service'
import { qadamPinUtil } from '../metadata/qadam-pin-util'
import { qadamVersionFetch } from './qadam-version-fetch'

// ADR-0003 "Fetching", the start-up half: every pinned qadam version this instance's flows name,
// missing from the store, fetched into it in the background. A failure is logged and stops nothing:
// a pin this does not land stays exactly as available (or not) as it was before this pass ran, and
// the existing unavailable-version fallback (#808) still covers it meanwhile.
//
// Modeled on `qadamVersionStoreSeeding` and `qadamSnapshotFollow`: one `distributedLock` across every
// API replica on the boot that runs it (correctness does not depend on the lock — the store's own
// atomic rename is what makes two writers of the same version safe — only wasted registry reads do),
// and a per-platform, per-project walk that counts failures and never aborts the whole pass on one
// bad row.
//
// Unlike `qadamSnapshotFollow`, which only ever moves a DRAFT's pin, this scans a flow's current
// DRAFT *and* its current published version: fetching bytes into the store rewrites nothing about a
// flow version, so there is no "never touch a LOCKED version" concern here, and ADR-0003 asks for
// "every pinned version that is missing", not just a draft's. A flow's older, no-longer-published
// LOCKED versions are not walked — unbounded with an instance's age and run-history retention, and
// not what makes a flow runnable today — and `fetchMissingStepPins` would do nothing for a snapshot
// or custom pin either, so a draft's or a published version's qadam step is where fetching the
// version it names actually helps.
export const qadamVersionFetchStartup = ({ log }: { log: FastifyBaseLogger }): { run: () => Promise<void> } => ({
    run: async (): Promise<void> => {
        const { error } = await tryCatch(() => fetchAll({ log }))
        if (!isNil(error)) {
            log.warn({ error: error.message }, '[qadamVersionFetchStartup] Fetching missing qadam pins into the store failed; the existing fallback runs as before')
        }
    },
})

const FETCH_LOCK_KEY = 'qadam-version-fetch-startup'
// Waiting replicas find the work done when they get the lock, so this only bounds a stuck holder.
const FETCH_LOCK_TIMEOUT_SECONDS = 15 * 60

async function fetchAll({ log }: { log: FastifyBaseLogger }): Promise<void> {
    const startedAt = Date.now()
    const report = await distributedLock(log).runExclusive({
        key: FETCH_LOCK_KEY,
        timeoutInSeconds: FETCH_LOCK_TIMEOUT_SECONDS,
        fn: () => fetchEveryPlatform({ log }),
    })
    log.info({ ...report, durationMs: Date.now() - startedAt }, '[qadamVersionFetchStartup] Fetched missing qadam pins into the store')
}

async function fetchEveryPlatform({ log }: { log: FastifyBaseLogger }): Promise<FetchStartupReport> {
    const platforms = await platformService(log).getAll()
    let flows = 0
    let fetched = 0
    let failed = 0
    for (const platform of platforms) {
        const { data: projectIds, error: projectsError } = await tryCatch(() => projectService(log).getProjectIdsByPlatform(platform.id))
        if (projectsError !== null) {
            log.warn({ err: projectsError, platformId: platform.id }, '[qadamVersionFetchStartup] could not list a platform\'s projects; skipping it this boot')
            failed += 1
            continue
        }
        const pins = new Set<string>()
        for (const projectId of projectIds) {
            const { data: versions, error: versionsError } = await tryCatch(() => findQadamFlowVersions({ projectId }))
            if (versionsError !== null) {
                log.warn({ err: versionsError, platformId: platform.id, projectId }, '[qadamVersionFetchStartup] could not read a project\'s flow versions; skipping it this boot')
                failed += 1
                continue
            }
            flows += versions.length
            versions.forEach((flowVersion) => {
                qadamPinUtil.collectDistinctPins({ steps: qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger }) }).forEach((pin) => pins.add(pin))
            })
        }
        if (pins.size === 0) {
            continue
        }
        const { data: summary, error: fetchError } = await tryCatch(() => qadamVersionFetch(log).fetchMissingPins({ pins: [...pins], platformId: platform.id }))
        if (fetchError !== null) {
            log.warn({ err: fetchError, platformId: platform.id }, '[qadamVersionFetchStartup] could not fetch a platform\'s missing qadam pins; skipping it this boot')
            failed += 1
            continue
        }
        fetched += summary.fetched
    }
    return { platforms: platforms.length, flows, fetched, failed }
}

async function findQadamFlowVersions({ projectId }: { projectId: ProjectId }): Promise<FlowVersion[]> {
    const flows = await flowRepo().find({ where: { projectId } })
    const flowIds = flows.map((flow) => flow.id)
    if (flowIds.length === 0) {
        return []
    }
    const publishedVersionIds = flows.flatMap((flow) => isNil(flow.publishedVersionId) ? [] : [flow.publishedVersionId])
    const drafts = await flowVersionRepo().find({ where: { flowId: In(flowIds), state: FlowVersionState.DRAFT } })
    const published = publishedVersionIds.length === 0 ? [] : await flowVersionRepo().find({ where: { id: In(publishedVersionIds) } })
    return [...drafts, ...published].filter((version) => qadamPinUtil.getQadamSteps({ trigger: version.trigger }).length > 0)
}

type FetchStartupReport = {
    platforms: number
    flows: number
    fetched: number
    failed: number
}

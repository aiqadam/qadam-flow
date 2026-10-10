import { apVersionUtil } from '@aiqadam/server-utils'
import { FlowVersion, FlowVersionState, isNil, PlatformId, ProjectId, qadamVersionParser, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { In } from 'typeorm'
import { distributedLock } from '../../database/redis-connections'
import { flowRepo } from '../../flows/flow/flow.repo'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { platformService } from '../../platform/platform.service'
import { projectService } from '../../project/project-service'
import { qadamPinUtil } from '../metadata/qadam-pin-util'
import { PinFallbackSeams } from './qadam-pin-fallback-seams'
import { qadamPinMoveService } from './qadam-pin-move.service'
import { qadamSnapshotPolicy } from './qadam-snapshot-policy'

// ADR-0004 "Following `main`": the start-up half of the snapshot policy. When the policy is `follow`
// (the default on a `-main` instance) every draft flow with an exact qadam pin is asked to follow the
// build the image ships for that qadam; a pin already at that build is a no-op, so the pass is safe
// to run on every boot and needs no "what the last image was" state. A failure is logged and stops
// nothing: a step it does not move keeps its pin and loads as before.
//
// The instance kind scopes what `follow` moves (ADR-0004): a `-main` snapshot instance moves release
// pins as well as snapshot pins, a release instance moves snapshot pins only. That is read from the
// platform version here and carried into the move, not inferred from the policy value.
//
// It only ever touches a DRAFT (the move's own rule), so a published version keeps running until the
// draft is published. The move, its checks, its audit record and its revert are `qadamPinMoveService`'s
// (`followAvailablePins`), cause `SNAPSHOT_FOLLOW`; nothing here re-derives them.
//
// `pin` returns before any walk, which is what every release instance does by default: no read, no write.
export const qadamSnapshotFollow = ({ log, seams }: QadamSnapshotFollowParams): { run: () => Promise<void> } => ({
    run: async (): Promise<void> => {
        const { error } = await tryCatch(() => follow({ log, seams }))
        if (!isNil(error)) {
            log.warn({ error: error.message }, '[qadamSnapshotFollow] Following the image\'s qadam builds failed; steps keep their pins')
        }
    },
})

const FOLLOW_LOCK_KEY = 'qadam-snapshot-follow'
// Waiting replicas find the work done when they get the lock, so this only bounds a stuck holder.
const FOLLOW_LOCK_TIMEOUT_SECONDS = 15 * 60

async function follow({ log, seams }: QadamSnapshotFollowParams): Promise<void> {
    const value = system.get(AppSystemProp.QADAM_SNAPSHOT_POLICY)
    if (!qadamSnapshotPolicy.isFollow({ value })) {
        log.info({ policy: value ?? 'pin' }, '[qadamSnapshotFollow] Snapshot policy is not `follow`; available qadam pins are left as they are')
        return
    }
    // ADR-0004 scopes `follow` by the instance kind, not by the policy value: on a `-main` snapshot
    // instance it moves release pins as well as snapshot pins, while a release instance moves snapshot
    // pins only. An operator can set `follow` on a release instance, so this is read from the platform
    // version and every move is told which instance it runs on.
    const instanceIsSnapshot = qadamVersionParser.isSnapshot({ version: apVersionUtil.getCurrentRelease() })
    const startedAt = Date.now()
    const report = await distributedLock(log).runExclusive({
        key: FOLLOW_LOCK_KEY,
        timeoutInSeconds: FOLLOW_LOCK_TIMEOUT_SECONDS,
        fn: () => followAll({ log, seams, instanceIsSnapshot }),
    })
    log.info({ ...report, instanceIsSnapshot, durationMs: Date.now() - startedAt }, '[qadamSnapshotFollow] Followed the image\'s qadam builds')
}

async function followAll({ log, seams, instanceIsSnapshot }: FollowAllParams): Promise<FollowReport> {
    const platforms = await platformService(log).getAll()
    let flows = 0
    let moved = 0
    let stayed = 0
    let failed = 0
    for (const platform of platforms) {
        // A platform, or one of its projects, that cannot be read is skipped, not fatal: one bad row
        // must not stop every later platform or project in the same boot.
        const { data: projectIds, error: projectsError } = await tryCatch(() => projectService(log).getProjectIdsByPlatform(platform.id))
        if (projectsError !== null) {
            log.warn({ err: projectsError, platformId: platform.id }, '[qadamSnapshotFollow] could not list a platform\'s projects; skipping it this boot')
            failed += 1
            continue
        }
        for (const projectId of projectIds) {
            const { data: drafts, error: draftsError } = await tryCatch(() => findQadamDrafts({ projectId }))
            if (draftsError !== null) {
                log.warn({ err: draftsError, platformId: platform.id, projectId }, '[qadamSnapshotFollow] could not read a project\'s drafts; skipping it this boot')
                failed += 1
                continue
            }
            for (const flowVersion of drafts) {
                const outcome = await followOne({ flowVersion, projectId, platformId: platform.id, log, seams, instanceIsSnapshot })
                flows += 1
                moved += outcome.moved
                stayed += outcome.stayed
                failed += outcome.failed
            }
        }
    }
    return { platforms: platforms.length, flows, moved, stayed, failed }
}

// Every query is platform- or project-scoped. A qadam step lives in the flow-version's trigger, so
// the flows are walked per project and their drafts read in one query; the pin walk is on the draft
// itself, which is why a draft with no qadam step never reaches the service.
async function findQadamDrafts({ projectId }: { projectId: ProjectId }): Promise<FlowVersion[]> {
    const flows = await flowRepo().find({ where: { projectId } })
    const flowIds = flows.map((flow) => flow.id)
    if (flowIds.length === 0) {
        return []
    }
    const drafts = await flowVersionRepo().find({ where: { flowId: In(flowIds), state: FlowVersionState.DRAFT } })
    return drafts.filter((draft) => qadamPinUtil.getQadamSteps({ trigger: draft.trigger }).length > 0)
}

async function followOne({ flowVersion, projectId, platformId, instanceIsSnapshot, log, seams }: FollowOneParams): Promise<FollowOutcome> {
    const { data, error } = await tryCatch(() => qadamPinMoveService({ log, seams }).followAvailablePins({ flowVersion, projectId, platformId, instanceIsSnapshot }))
    if (error !== null) {
        log.warn({ err: error, flowId: flowVersion.flowId, flowVersionId: flowVersion.id }, '[qadamSnapshotFollow] could not follow a flow\'s available qadam pins; leaving them as they are')
        return { moved: 0, stayed: 0, failed: 1 }
    }
    // Debug, not warn: on a `-main` instance a step already at the image's build stays with
    // `pin-is-image-version` on every boot, and that is the normal, quiet case, not a problem.
    data.stayed.forEach((stay) => {
        log.debug({ flowId: flowVersion.flowId, flowVersionId: flowVersion.id, stepName: stay.stepName, qadamName: stay.qadamName, pinnedVersion: stay.version, reason: stay.reason, detail: stay.detail }, '[qadamSnapshotFollow] a step\'s available qadam pin was not followed')
    })
    return { moved: data.moved.length, stayed: data.stayed.length, failed: 0 }
}

type QadamSnapshotFollowParams = {
    log: FastifyBaseLogger
    // A seam for tests only: the pass's own default is `qadamPinMoveService`'s real seams.
    seams?: PinFallbackSeams
}

type FollowAllParams = QadamSnapshotFollowParams & {
    instanceIsSnapshot: boolean
}

type FollowOneParams = FollowAllParams & {
    flowVersion: FlowVersion
    projectId: ProjectId
    platformId: PlatformId
}

type FollowOutcome = {
    moved: number
    stayed: number
    failed: number
}

type FollowReport = {
    platforms: number
    flows: number
    moved: number
    stayed: number
    failed: number
}

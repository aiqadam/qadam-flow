import { MoveVerdict, PinMetadata, qadamPinFallbackDecision, StayReason, StepTarget } from '@aiqadam/server-utils'
import {
    apId,
    ErrorCode,
    FlowId,
    FlowOperationType,
    FlowStatus,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    isNil,
    PlatformId,
    ProjectId,
    QadamFlowError,
    qadamVersionParser,
    SeekPage,
    tryCatch,
    UserId,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { flowExecutionCache } from '../../flows/flow/flow-execution-cache'
import { flowRepo } from '../../flows/flow/flow.repo'
import { flowService } from '../../flows/flow/flow.service'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { projectService } from '../../project/project-service'
import { qadamMetadataService } from '../metadata/qadam-metadata-service'
import { QadamPinnedStep, qadamPinUtil } from '../metadata/qadam-pin-util'
import { ImageBuildWithMetadata, PinFallbackSeams, qadamPinFallbackSeams } from './qadam-pin-fallback-seams'
import { ListQadamPinMovesRequestQuery, QadamPinMove, QadamPinMoveCause } from './qadam-pin-move.dto'
import { QadamPinMoveEntity } from './qadam-pin-move.entity'
import { qadamPinRewrite } from './qadam-pin-rewrite'
import { qadamPinVersionWriter } from './qadam-pin-version-writer'

export const qadamPinMoveRepo = repoFactory(QadamPinMoveEntity)

// ADR-0003 "Unavailable version" and "Versions that were never published": a step whose pinned
// qadam version cannot be had is moved to the image's version, only when `qadamPinFallbackDecision`
// allows it (caret range, props where metadata exists, the target loaded), and only after that. The
// move is the rewrite of the step's pin in the flow version and one audit record, committed together,
// so there is never a rewrite without its record. A person can revert it (`revert`), and the step is
// then held: a later publish or enable does not move it again.
//
// It never disables a flow and never throws a step off a flow (#435): a step it does not move stays
// as it is and is reported with the reason, which is what the "update this step" marking reads.
// `seams` is where the image, the pinned version's metadata and the props checker come from.
export const qadamPinMoveService = ({ log, seams = qadamPinFallbackSeams({ log }) }: { log: FastifyBaseLogger, seams?: PinFallbackSeams }) => ({
    async moveUnavailablePins({ flowVersion, projectId, platformId, cause, actorUserId }: MoveUnavailablePinsParams): Promise<MoveUnavailablePinsResult> {
        const steps = qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger }).filter(isExactPin)
        if (steps.length === 0) {
            return { flowVersion, moved: [], stayed: [] }
        }
        const unavailable = await findUnavailablePins({ steps, platformId, log })
        if (unavailable.size === 0) {
            return { flowVersion, moved: [], stayed: [] }
        }
        // Before anything reads or writes on the flow's behalf, and only when there is something to do:
        // most publishes and enables have no unavailable pin and cost no extra query.
        await assertFlowBelongsTo({ flowId: flowVersion.flowId, projectId, platformId, log })
        const held = await findHeldRewrites({ flowId: flowVersion.flowId, platformId })
        const plan = await planMoves({ steps: steps.filter((step) => unavailable.has(qadamPinUtil.pinOf({ step }))), held, platformId, seams })
        if (plan.moves.length === 0) {
            return { flowVersion, moved: [], stayed: plan.stayed }
        }

        const committed = await qadamPinMoveRepo().manager.transaction(async (manager) => {
            return commitMoves({ manager, flowVersion, platformId, projectId, cause, actorUserId, moves: plan.moves })
        })
        committed.moved.forEach((record) => {
            log.info({ flowId: record.flowId, flowVersionId: record.flowVersionId, stepName: record.stepName, qadamName: record.qadamName, from: record.fromVersion, to: record.toVersion, propsCheck: record.propsCheck, cause }, '[qadamPinMoveService] moved a step off an unavailable qadam version')
        })
        return { flowVersion: committed.flowVersion, moved: committed.moved, stayed: [...plan.stayed, ...committed.lost] }
    },

    async list({ platformId, query }: { platformId: PlatformId, query: ListQadamPinMovesRequestQuery }): Promise<SeekPage<QadamPinMove>> {
        const decodedCursor = paginationHelper.decodeCursor(query.cursor ?? null)
        const paginator = buildPaginator({
            entity: QadamPinMoveEntity,
            query: {
                limit: query.limit ?? 10,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const dbQuery = qadamPinMoveRepo().createQueryBuilder(QadamPinMoveEntity.options.name).where({
            platformId,
            ...(isNil(query.flowId) ? {} : { flowId: query.flowId }),
            ...(isNil(query.status) ? {} : { status: query.status }),
        })
        const { data, cursor } = await paginator.paginate(dbQuery)
        return paginationHelper.createPage<QadamPinMove>(data, cursor)
    },

    async getOneOrThrow({ id, platformId }: { id: string, platformId: PlatformId }): Promise<QadamPinMove> {
        const record = await qadamPinMoveRepo().findOneBy({ id, platformId })
        if (isNil(record)) {
            throw notFound({ id })
        }
        return record
    },

    // Puts the step's pin back to the version it was moved from. It refuses when the step is no
    // longer on the version the move wrote (a person has edited it since): that edit is theirs.
    async revert({ id, platformId, userId }: { id: string, platformId: PlatformId, userId: UserId }): Promise<QadamPinMove> {
        const { record: reverted, triggerReplaced, flowWasEnabled } = await qadamPinMoveRepo().manager.transaction(async (manager) => {
            return revertInTransaction({ manager, id, platformId, userId })
        })
        await flowExecutionCache(log).invalidate(reverted.flowId)
        if (triggerReplaced && flowWasEnabled) {
            await reregisterTrigger({ flowId: reverted.flowId, projectId: reverted.projectId, platformId, userId, log })
        }
        log.info({ flowId: reverted.flowId, flowVersionId: reverted.flowVersionId, stepName: reverted.stepName, qadamName: reverted.qadamName, from: reverted.toVersion, to: reverted.fromVersion, userId }, '[qadamPinMoveService] reverted a qadam pin move')
        return reverted
    },
})

async function assertFlowBelongsTo({ flowId, projectId, platformId, log }: { flowId: FlowId, projectId: ProjectId, platformId: PlatformId, log: FastifyBaseLogger }): Promise<void> {
    const flow = await flowRepo().findOneBy({ id: flowId, projectId })
    const flowPlatformId = isNil(flow) ? null : await projectService(log).getPlatformId(projectId)
    if (isNil(flow) || flowPlatformId !== platformId) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityType: 'flow', entityId: flowId, message: `flow_not_found id=${flowId}` },
        })
    }
}

// A pin whose availability could not be read (the lookup errored) is not in the set: a transient
// failure must never read as "unavailable" and persist a rewrite.
async function findUnavailablePins({ steps, platformId, log }: { steps: QadamPinnedStep[], platformId: PlatformId, log: FastifyBaseLogger }): Promise<Set<string>> {
    const pins = qadamPinUtil.collectDistinctPins({ steps })
    const answers = await Promise.all(pins.map(async (pin): Promise<[string, boolean | undefined]> => {
        const { name, version } = qadamPinUtil.splitPin({ pin })
        const { data, error } = await tryCatch(() => qadamMetadataService(log).isPinAvailable({ name, version, platformId }))
        return [pin, isNil(error) && !isNil(data) ? data : undefined]
    }))
    return new Set(answers.filter(([, available]) => available === false).map(([pin]) => pin))
}

async function findHeldRewrites({ flowId, platformId, manager }: { flowId: FlowId, platformId: PlatformId, manager?: EntityManager }): Promise<Set<string>> {
    const reverted = await qadamPinMoveRepo(manager).findBy({ flowId, platformId, status: 'REVERTED' })
    return new Set(reverted.map((record) => heldKey({ stepName: record.stepName, qadamName: record.qadamName, version: record.fromVersion })))
}

async function planMoves({ steps, held, platformId, seams }: { steps: QadamPinnedStep[], held: Set<string>, platformId: PlatformId, seams: PinFallbackSeams }): Promise<MovePlan> {
    const images = new Map<string, Promise<ImageBuildWithMetadata | null>>()
    const pinMetadata = new Map<string, Promise<PinMetadata>>()
    const outcomes = await Promise.all(steps.map(async (step): Promise<StepOutcome> => {
        const { qadamName, qadamVersion } = step.settings
        const base = { stepName: step.name, qadamName, version: qadamVersion }
        if (held.has(heldKey({ stepName: step.name, qadamName, version: qadamVersion }))) {
            return { ...base, move: false, reason: 'reverted-by-user', detail: 'a person reverted a move of this step, so it is not moved again until its version is changed' }
        }
        const image = await memoize({ cache: images, key: qadamName, load: () => seams.imageBuild({ name: qadamName, platformId }) })
        // Without an image build the decision cannot move the step, so the catalogue is not read for it.
        const metadata: PinMetadata = image === null
            ? { status: 'unknown' }
            : await memoize({ cache: pinMetadata, key: `${qadamName}@${qadamVersion}`, load: () => seams.pinMetadata({ name: qadamName, version: qadamVersion }) })
        const verdict: MoveVerdict = qadamPinFallbackDecision.decide({
            pinnedVersion: qadamVersion,
            image: image?.build ?? null,
            props: { pin: metadata, imageMetadata: image?.metadata ?? null, target: targetOf({ step }), checker: seams.propsChecker },
        })
        if (!verdict.move) {
            return { ...base, move: false, reason: verdict.reason, detail: verdict.detail }
        }
        return { ...base, move: true, to: verdict.to, propsCheck: verdict.propsCheck }
    }))
    return {
        moves: outcomes.flatMap((outcome) => outcome.move ? [outcome] : []),
        stayed: outcomes.flatMap((outcome) => outcome.move ? [] : [{ stepName: outcome.stepName, qadamName: outcome.qadamName, version: outcome.version, reason: outcome.reason, detail: outcome.detail }]),
    }
}

// The rewrite and its records, one transaction on a locked row: the trigger is read again under the
// lock, so a step edited since the plan was made is dropped from the move and reported, not
// overwritten with a stale copy of the flow version.
async function commitMoves({ manager, flowVersion, platformId, projectId, cause, actorUserId, moves }: CommitMovesParams): Promise<CommittedMoves> {
    const current = await flowVersionRepo(manager).findOne({ where: { id: flowVersion.id, flowId: flowVersion.flowId }, lock: { mode: 'for_no_key_update' } })
    if (isNil(current)) {
        return { flowVersion, moved: [], lost: moves.map((move) => lostReason({ stepName: move.stepName, qadamName: move.qadamName, version: move.version })) }
    }
    // Read again under the lock: a revert that committed after the plan was made holds the step.
    const held = await findHeldRewrites({ flowId: current.flowId, platformId, manager })
    const freshMoves = moves.filter((move) => !held.has(heldKey({ stepName: move.stepName, qadamName: move.qadamName, version: move.version })))
    const heldMoves = moves.filter((move) => !freshMoves.includes(move))
    const { flowVersion: rewritten, applied, skipped } = qadamPinRewrite.applyAll({
        flowVersion: current,
        rewrites: freshMoves.map((move) => ({ stepName: move.stepName, qadamName: move.qadamName, fromVersion: move.version, toVersion: move.to, propsCheck: move.propsCheck })),
    })
    const lost = [
        ...heldMoves.map((move) => lostReason({ stepName: move.stepName, qadamName: move.qadamName, version: move.version, reason: 'reverted-by-user', detail: 'a person reverted a move of this step, so it is not moved again until its version is changed' })),
        ...skipped.map((rewrite) => lostReason({ stepName: rewrite.stepName, qadamName: rewrite.qadamName, version: rewrite.fromVersion })),
    ]
    if (applied.length === 0) {
        return { flowVersion: current, moved: [], lost }
    }
    const flow = await flowRepo(manager).findOneBy({ id: current.flowId, projectId })
    const written = await qadamPinVersionWriter.write({ manager, current, trigger: rewritten.trigger, projectId, publishedVersionId: flow?.publishedVersionId ?? null })
    const stored = written.flowVersion
    const records = applied.map((rewrite): QadamPinMove => {
        const now = dayjs().toISOString()
        return {
            id: apId(),
            created: now,
            updated: now,
            platformId,
            projectId,
            flowId: current.flowId,
            flowVersionId: stored.id,
            stepName: rewrite.stepName,
            qadamName: rewrite.qadamName,
            fromVersion: rewrite.fromVersion,
            toVersion: rewrite.toVersion,
            propsCheck: rewrite.propsCheck,
            cause,
            status: 'APPLIED',
            movedBy: actorUserId ?? null,
            revertedAt: null,
            revertedBy: null,
        }
    })
    await qadamPinMoveRepo(manager).insert(records)
    return { flowVersion: stored, moved: records, lost }
}

async function revertInTransaction({ manager, id, platformId, userId }: { manager: EntityManager, id: string, platformId: PlatformId, userId: UserId }): Promise<RevertedInTransaction> {
    const record = await qadamPinMoveRepo(manager).findOne({ where: { id, platformId }, lock: { mode: 'for_no_key_update' } })
    if (isNil(record)) {
        throw notFound({ id })
    }
    if (record.status !== 'APPLIED') {
        throw refused({ message: 'This move was already reverted.' })
    }
    const rewrite = { stepName: record.stepName, qadamName: record.qadamName, fromVersion: record.toVersion, toVersion: record.fromVersion }
    // The version the move wrote, the flow's drafts and its published version: an edit after a publish copies the published
    // version into a new draft that carries the moved pin, and publishing that draft would put it
    // back. Each is rewritten only where the step is still on the version the move wrote.
    const drafts = await flowVersionRepo(manager).find({ where: { flowId: record.flowId, state: FlowVersionState.DRAFT }, lock: { mode: 'for_no_key_update' } })
    const moved = await flowVersionRepo(manager).findOne({ where: { id: record.flowVersionId, flowId: record.flowId }, lock: { mode: 'for_no_key_update' } })
    if (isNil(moved)) {
        throw refused({ message: 'The flow version this move changed no longer exists.' })
    }
    // And the flow's published version: a republish copies the moved version, still on the moved pin,
    // and no new move follows because that pin is available.
    const flow = await flowRepo(manager).findOneBy({ id: record.flowId, projectId: record.projectId })
    const published = isNil(flow?.publishedVersionId) ? null : await flowVersionRepo(manager).findOne({ where: { id: flow.publishedVersionId, flowId: record.flowId }, lock: { mode: 'for_no_key_update' } })
    const others = [...drafts, ...(isNil(published) ? [] : [published])].filter((candidate, index, all) => candidate.id !== moved.id && all.findIndex((other) => other.id === candidate.id) === index)
    const candidates = [moved, ...others]
    const rewrites = candidates.flatMap((candidate) => {
        const rewritten = qadamPinRewrite.apply({ flowVersion: candidate, rewrite })
        return isNil(rewritten) ? [] : [{ candidate, trigger: rewritten.trigger }]
    })
    if (rewrites.length === 0) {
        throw refused({ message: `The step ${record.stepName} is no longer pinned to ${record.toVersion}, so there is nothing to revert. Change its version in the builder.` })
    }
    let triggerReplaced = false
    for (const write of rewrites) {
        const written = await qadamPinVersionWriter.write({ manager, current: write.candidate, trigger: write.trigger, projectId: record.projectId, publishedVersionId: flow?.publishedVersionId ?? null })
        triggerReplaced = triggerReplaced || (written.replacedPublished && write.candidate.trigger.name === record.stepName)
    }
    const revertedAt = dayjs().toISOString()
    await qadamPinMoveRepo(manager).update({ id: record.id, platformId }, { status: 'REVERTED', revertedAt, revertedBy: userId })
    return { record: { ...record, status: 'REVERTED', revertedAt, revertedBy: userId }, triggerReplaced, flowWasEnabled: flow?.status === FlowStatus.ENABLED }
}

type RevertedInTransaction = {
    record: QadamPinMove
    // The published version's trigger step was the one rewritten: its trigger source still holds the moved pin.
    triggerReplaced: boolean
    flowWasEnabled: boolean
}

// The trigger source was registered from the version that was published, with its pin. Disabling and
// enabling the flow registers it again from the new published version, through the same status change
// a person makes. The enable asks the pin check again; the revert holds the step, so it stays put.
async function reregisterTrigger({ flowId, projectId, platformId, userId, log }: { flowId: FlowId, projectId: ProjectId, platformId: PlatformId, userId: UserId, log: FastifyBaseLogger }): Promise<void> {
    const change = (status: FlowStatus): Promise<unknown> => flowService(log).update({ id: flowId, projectId, platformId, userId, operation: { type: FlowOperationType.CHANGE_STATUS, request: { status } } })
    const { error: disableError } = await tryCatch(() => change(FlowStatus.DISABLED))
    const { error: enableError } = await tryCatch(() => change(FlowStatus.ENABLED))
    if (!isNil(disableError) || !isNil(enableError)) {
        log.error({ flowId, disableError: String(disableError), enableError: String(enableError) }, '[qadamPinMoveService] the pin move was reverted but the flow\'s trigger could not be registered again; enable the flow to do it')
    }
}

function isExactPin(step: QadamPinnedStep): boolean {
    return qadamVersionParser.parsePin({ pin: step.settings.qadamVersion })?.range === null
}

function targetOf({ step }: { step: QadamPinnedStep }): StepTarget | null {
    if (step.type === FlowTriggerType.PIECE) {
        return isNil(step.settings.triggerName) ? null : { kind: 'trigger', name: step.settings.triggerName }
    }
    return isNil(step.settings.actionName) ? null : { kind: 'action', name: step.settings.actionName }
}

function heldKey({ stepName, qadamName, version }: { stepName: string, qadamName: string, version: string }): string {
    return JSON.stringify([stepName, qadamName, version])
}

function memoize<T>({ cache, key, load }: { cache: Map<string, Promise<T>>, key: string, load: () => Promise<T> }): Promise<T> {
    const known = cache.get(key)
    if (!isNil(known)) {
        return known
    }
    const loading = load()
    cache.set(key, loading)
    return loading
}

function lostReason({ stepName, qadamName, version, reason = 'changed-meanwhile', detail = 'the step was edited or removed after the move was planned, so it was left as it is' }: { stepName: string, qadamName: string, version: string, reason?: PinStayReason, detail?: string }): PinStay {
    return { stepName, qadamName, version, reason, detail }
}

function notFound({ id }: { id: string }): QadamFlowError {
    return new QadamFlowError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        params: { entityType: 'qadam_pin_move', entityId: id, message: `qadam_pin_move_not_found id=${id}` },
    })
}

function refused({ message }: { message: string }): QadamFlowError {
    return new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } })
}

type MoveUnavailablePinsParams = {
    flowVersion: FlowVersion
    projectId: ProjectId
    platformId: PlatformId
    cause: QadamPinMoveCause
    // The person whose publish or enable caused it, when there is one.
    actorUserId?: UserId
}

type PlannedMove = {
    stepName: string
    qadamName: string
    version: string
    to: string
    propsCheck: QadamPinMove['propsCheck']
}

type StepOutcome =
    | ({ move: true } & PlannedMove)
    | { move: false, stepName: string, qadamName: string, version: string, reason: PinStayReason, detail: string }

type MovePlan = {
    moves: PlannedMove[]
    stayed: PinStay[]
}

type CommitMovesParams = {
    manager: EntityManager
    flowVersion: FlowVersion
    platformId: PlatformId
    projectId: ProjectId
    cause: QadamPinMoveCause
    actorUserId?: UserId
    moves: PlannedMove[]
}

type CommittedMoves = {
    flowVersion: FlowVersion
    moved: QadamPinMove[]
    lost: PinStay[]
}

export type PinStayReason = StayReason | 'reverted-by-user' | 'changed-meanwhile'

// A step with an unavailable pin that was not moved, and why: what "update this step" says.
export type PinStay = {
    stepName: string
    qadamName: string
    version: string
    reason: PinStayReason
    detail: string
}

export type MoveUnavailablePinsResult = {
    // The flow version as stored after the moves: the caller carries on with this one, never with
    // the copy it passed in, or its next save would overwrite the rewrite.
    flowVersion: FlowVersion
    moved: QadamPinMove[]
    stayed: PinStay[]
}

import { ApId, BaseModelSchema, DateOrString, SeekPage } from '@aiqadam/shared'
import { z } from 'zod'

// The audit record of #808: one row per step a pin move rewrote (ADR-0003 "Unavailable version").
// It says what moved, which checks it passed, and is what a revert works from. It is platform
// scoped: every read and write filters by `platformId`.
export const QadamPinMoveStatus = z.enum(['APPLIED', 'REVERTED'])

// What caused the move: the step's flow was published (its draft was moved before it was locked),
// or the start-up `follow` pass (ADR-0004) moved an available pin onto the build the image ships.
export const QadamPinMoveCause = z.enum(['PUBLISH', 'SNAPSHOT_FOLLOW'])

// How the props were checked: against the pinned version's metadata, or not at all because the
// catalogue was read and has no entry for it (a pin that was never published, ADR-0003 "Versions
// that were never published"). An unreadable catalogue is not this: that step is not moved.
export const QadamPinMovePropsCheck = z.enum(['compatible', 'not-checked-no-metadata'])

export const QadamPinMove = z.object({
    ...BaseModelSchema,
    platformId: ApId,
    projectId: ApId,
    flowId: ApId,
    flowVersionId: ApId,
    stepName: z.string(),
    qadamName: z.string(),
    fromVersion: z.string(),
    toVersion: z.string(),
    propsCheck: QadamPinMovePropsCheck,
    cause: QadamPinMoveCause,
    status: QadamPinMoveStatus,
    movedBy: z.string().nullable(),
    revertedAt: DateOrString.nullable(),
    revertedBy: z.string().nullable(),
})

export const ListQadamPinMovesRequestQuery = z.object({
    flowId: ApId.optional(),
    status: QadamPinMoveStatus.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
})

// The builder's project-scoped read of the hold (#855, ADR-0004 "Following `main`"): the REVERTED
// records of one flow. A person reverted a move of that step, so `follow` does not move it again
// until the step's version changes; this query names the flow whose held steps are read.
export const ListHeldQadamPinMovesRequestQuery = z.object({
    flowId: ApId,
})

// The published version keeps running until the restored draft is published.
export const RevertedQadamPinMove = QadamPinMove.extend({ publishRequired: z.boolean() })

export const QadamPinMovePage = SeekPage(QadamPinMove)

// Every reason `qadamPinFallbackDecision.decide` (`StayReason`) and `qadamPinMoveService` name for
// a step whose pin was not moved, mirrored here like `QadamPinMovePropsCheck` so the response is
// schema validated: a reason this enum does not list fails to serialize rather than reaching a
// caller silently.
export const QadamPinStayReason = z.enum([
    'pin-unreadable',
    'pin-is-a-range',
    'image-lacks-qadam',
    'image-version-unreadable',
    'pin-is-image-version',
    'outside-caret',
    'snapshot-without-metadata',
    'props-unverifiable',
    'props-incompatible',
    'target-not-loaded',
    'reverted-by-user',
    'changed-meanwhile',
    'release-pin-on-release-instance',
])

// ADR-0003 "Unavailable version": a step whose pinned qadam version is unavailable and was not
// moved to the image's build, with why — what "version unavailable — update this step" marks.
export const QadamPinStay = z.object({
    stepName: z.string(),
    qadamName: z.string(),
    version: z.string(),
    reason: QadamPinStayReason,
    detail: z.string(),
})

export const QadamPinStayCheck = z.object({
    pinStays: z.array(QadamPinStay),
})

// The builder's, MCP's and runs' project-scoped read of one flow version's unavailable pins.
export const CheckQadamPinStaysRequestQuery = z.object({
    flowId: ApId,
    flowVersionId: ApId,
})

export type QadamPinMove = z.infer<typeof QadamPinMove>
export type QadamPinMoveStatus = z.infer<typeof QadamPinMoveStatus>
export type QadamPinMoveCause = z.infer<typeof QadamPinMoveCause>
export type QadamPinMovePropsCheck = z.infer<typeof QadamPinMovePropsCheck>
export type ListQadamPinMovesRequestQuery = z.infer<typeof ListQadamPinMovesRequestQuery>
export type ListHeldQadamPinMovesRequestQuery = z.infer<typeof ListHeldQadamPinMovesRequestQuery>
export type RevertedQadamPinMove = z.infer<typeof RevertedQadamPinMove>
export type QadamPinStayReason = z.infer<typeof QadamPinStayReason>
export type QadamPinStay = z.infer<typeof QadamPinStay>
export type QadamPinStayCheck = z.infer<typeof QadamPinStayCheck>
export type CheckQadamPinStaysRequestQuery = z.infer<typeof CheckQadamPinStaysRequestQuery>

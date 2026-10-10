import { ApId, BaseModelSchema, DateOrString, SeekPage } from '@aiqadam/shared'
import { z } from 'zod'

// The audit record of #808: one row per step a pin move rewrote (ADR-0003 "Unavailable version").
// It says what moved, which checks it passed, and is what a revert works from. It is platform
// scoped: every read and write filters by `platformId`.
export const QadamPinMoveStatus = z.enum(['APPLIED', 'REVERTED'])

// What caused the move: the step's flow was published, or enabled with its published version.
export const QadamPinMoveCause = z.enum(['PUBLISH', 'ENABLE'])

// How the props were checked: against the pinned version's metadata, or not at all because none
// exists (a pin that was never published, ADR-0003 "Versions that were never published").
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

export const QadamPinMovePage = SeekPage(QadamPinMove)

export type QadamPinMove = z.infer<typeof QadamPinMove>
export type QadamPinMoveStatus = z.infer<typeof QadamPinMoveStatus>
export type QadamPinMoveCause = z.infer<typeof QadamPinMoveCause>
export type QadamPinMovePropsCheck = z.infer<typeof QadamPinMovePropsCheck>
export type ListQadamPinMovesRequestQuery = z.infer<typeof ListQadamPinMovesRequestQuery>

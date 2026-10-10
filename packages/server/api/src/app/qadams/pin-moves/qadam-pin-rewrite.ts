import { flowStructureUtil, FlowVersion, isNil } from '@aiqadam/shared'
import { qadamPinUtil } from '../metadata/qadam-pin-util'

// The one write a pin move and its revert make to a flow version: a step's `qadamVersion`, and
// nothing else about the step. It answers null when the step is not where the caller expects it
// (renamed, deleted, or already on another version), so a move planned from a stale read, or a
// revert after the step was edited, writes nothing.
export const qadamPinRewrite = {
    apply: ({ flowVersion, rewrite }: { flowVersion: FlowVersion, rewrite: PinRewrite }): FlowVersion | null => {
        const step = qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger }).find((candidate) => candidate.name === rewrite.stepName)
        if (isNil(step) || step.settings.qadamName !== rewrite.qadamName || step.settings.qadamVersion !== rewrite.fromVersion) {
            return null
        }
        // By name, as `migrate-v31` does: `transferFlow` calls back for every step.
        return flowStructureUtil.transferFlow(flowVersion, (candidate) => {
            if (candidate.name !== rewrite.stepName) {
                return candidate
            }
            return { ...candidate, settings: { ...candidate.settings, qadamVersion: rewrite.toVersion } }
        })
    },

    // Several rewrites in turn; one that finds its step somewhere else is left out and reported.
    applyAll: <T extends PinRewrite>({ flowVersion, rewrites }: { flowVersion: FlowVersion, rewrites: T[] }): AppliedRewrites<T> => {
        return rewrites.reduce<AppliedRewrites<T>>((applied, rewrite) => {
            const next = qadamPinRewrite.apply({ flowVersion: applied.flowVersion, rewrite })
            return isNil(next)
                ? { ...applied, skipped: [...applied.skipped, rewrite] }
                : { flowVersion: next, applied: [...applied.applied, rewrite], skipped: applied.skipped }
        }, { flowVersion, applied: [], skipped: [] })
    },
}

export type PinRewrite = {
    stepName: string
    qadamName: string
    fromVersion: string
    toVersion: string
}

export type AppliedRewrites<T extends PinRewrite = PinRewrite> = {
    flowVersion: FlowVersion
    applied: T[]
    skipped: T[]
}

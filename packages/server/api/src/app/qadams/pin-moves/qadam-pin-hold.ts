import { flowQadamUtil, isNil } from '@aiqadam/shared'

// ADR-0004 "Following `main`": the hold a revert leaves behind. A `REVERTED` record holds the step
// whenever it sits on the record's `fromVersion` again — the same key `findHeldRewrites` builds —
// so `follow` does not move it a second time until a person changes its version. Both pin-reporting
// MCP tools read the hold through this one matcher, so they cannot disagree about which steps are
// held (#854).
export const qadamPinHold = {
    findForStep({ step, moves }: FindForStepParams): HeldMove | null {
        const version = flowQadamUtil.getExactVersion(step.settings.qadamVersion)
        const matches = moves.filter((move) => move.status === 'REVERTED'
            && move.stepName === step.name
            && move.qadamName === step.settings.qadamName
            && move.fromVersion === version)
        if (matches.length === 0) {
            return null
        }
        // A flow with a long history can hold more than one reverted move for the same version;
        // the newest is the one that explains why the step stops following today. TypeORM returns
        // the timestamp column as a `Date`, so normalize before comparing.
        const [newest] = matches.sort((a, b) => revertedAtTime(b) - revertedAtTime(a))
        return { fromVersion: newest.fromVersion, toVersion: newest.toVersion, revertedAt: revertedAtKey(newest) }
    },
}

function revertedAtKey(move: HoldMove): string | null {
    if (isNil(move.revertedAt)) {
        return null
    }
    return move.revertedAt instanceof Date ? move.revertedAt.toISOString() : move.revertedAt
}

function revertedAtTime(move: HoldMove): number {
    const key = revertedAtKey(move)
    return isNil(key) ? 0 : Date.parse(key)
}

type HoldStep = {
    name: string
    settings: {
        qadamName: string
        qadamVersion: string
    }
}

type HoldMove = {
    status: 'APPLIED' | 'REVERTED'
    stepName: string
    qadamName: string
    fromVersion: string
    toVersion: string
    revertedAt: string | Date | null
}

type HeldMove = {
    fromVersion: string
    toVersion: string
    revertedAt: string | null
}

type FindForStepParams = {
    step: HoldStep
    moves: HoldMove[]
}

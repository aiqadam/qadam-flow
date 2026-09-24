import { BaseStepOutput, FlowActionType, isNil, StepOutput } from '@aiqadam/shared'
import { utils } from '../utils'
import { sizeofUtils } from './sizeof'

const DEFAULT_INPUT_TRUNCATE_THRESHOLD_KB = 2
const INPUT_TRUNCATE_THRESHOLD_BYTES = Number(
    process.env.AP_FLOW_RUN_LOG_INPUT_TRUNCATE_THRESHOLD_KB ?? DEFAULT_INPUT_TRUNCATE_THRESHOLD_KB,
) * 1024

const DEFAULT_MAX_LOG_SIZE_MB = 50
const ERROR_OFFSET = 256 * 1024
const MAX_LOG_SIZE = Number(process.env.AP_MAX_FLOW_RUN_LOG_SIZE_MB ?? DEFAULT_MAX_LOG_SIZE_MB) * 1024 * 1024
const MAX_SIZE_FOR_ALL_ENTRIES = MAX_LOG_SIZE - ERROR_OFFSET

const truncatedLoopInputs = new WeakMap<Record<string, unknown>, unknown>()

const logSizeTrackers = new WeakMap<Record<string, StepOutput>, LogSizeTracker>()

const FIRST_FORCED_WALK_AFTER_UPSERTS = 256

// `{}` plus the separating comma.
const EMPTY_ITERATION_BYTES = 3

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatSize(bytes: number): string {
    const kb = bytes / 1024
    if (kb < 1024) {
        return `${Math.round(kb)} KB`
    }
    return `${(kb / 1024).toFixed(1)} MB`
}

export const loggingUtils = {
    maybeTruncateInput(input: unknown, threshold: number = INPUT_TRUNCATE_THRESHOLD_BYTES): unknown {
        if (!isPlainRecord(input)) {
            return input
        }
        return truncateRecord({ input, threshold })
    },
    // A loop re-writes its own step every iteration with the same resolved `input`, so without the
    // memo the whole `items` list was stringified once per iteration (#387). Only the loop's own
    // input is memoized: a qadam step's input is written before and after `run()`, and the action
    // can grow it in between, which a memo would log untruncated.
    maybeTruncateLoopInput(input: unknown): unknown {
        if (!isPlainRecord(input)) {
            return input
        }
        const memo = truncatedLoopInputs.get(input)
        if (!isNil(memo)) {
            return memo
        }
        const result = truncateRecord({ input, threshold: INPUT_TRUNCATE_THRESHOLD_BYTES })
        truncatedLoopInputs.set(input, result)
        return result
    },
    maxLogSizeMb: MAX_LOG_SIZE / (1024 * 1024),
    // Walking the whole journal after every step made a loop quadratic: at 800 iterations 84% of
    // the run was this check (#387). The walk now happens only when the size last measured plus an
    // upper bound on everything written since could cross the cap, and on a doubling schedule of
    // writes. The bound only sees writes: a qadam that grows an object already in the journal in
    // place is invisible to it, and the schedule — plus the walk `isWithinSizeLimitAfterFullWalk`
    // does when a run ends — keeps that from going unnoticed. Walks at doubling intervals cost
    // O(final size) in total, so the check stays linear.
    isWithinSizeLimit(steps: Record<string, StepOutput>, maxSize: number = MAX_SIZE_FOR_ALL_ENTRIES): boolean {
        const tracked = logSizeTrackers.get(steps)
        const provablyWithin = !isNil(tracked)
            && tracked.upsertsSinceWalk < tracked.walkEveryUpserts
            && tracked.measuredBytes + tracked.growthBoundBytes <= maxSize
        if (provablyWithin) {
            return true
        }
        return walkAndRecord({ steps, maxSize, walkEveryUpserts: isNil(tracked) ? FIRST_FORCED_WALK_AFTER_UPSERTS : tracked.walkEveryUpserts * 2 })
    },
    isWithinSizeLimitAfterFullWalk(steps: Record<string, StepOutput>, maxSize: number = MAX_SIZE_FOR_ALL_ENTRIES): boolean {
        const tracked = logSizeTrackers.get(steps)
        return walkAndRecord({ steps, maxSize, walkEveryUpserts: tracked?.walkEveryUpserts ?? FIRST_FORCED_WALK_AFTER_UPSERTS })
    },
    // Called for every write into a journal. Only journals already measured are tracked: a journal
    // restored on RESUME, or written to before its first check, is measured in full on that check.
    recordUpsert({ steps, stepName, stepOutput, previous }: RecordUpsertParams): void {
        const tracked = logSizeTrackers.get(steps)
        if (isNil(tracked)) {
            return
        }
        tracked.growthBoundBytes += upsertGrowthBound({ stepName, stepOutput, previous })
        tracked.upsertsSinceWalk += 1
    },
}

function walkAndRecord({ steps, maxSize, walkEveryUpserts }: { steps: Record<string, StepOutput>, maxSize: number, walkEveryUpserts: number }): boolean {
    const measuredBytes = sizeofUtils.recursiveSizeof(steps)
    logSizeTrackers.set(steps, { measuredBytes, growthBoundBytes: 0, upsertsSinceWalk: 0, walkEveryUpserts })
    return measuredBytes <= maxSize
}

function truncateRecord({ input, threshold }: { input: Record<string, unknown>, threshold: number }): unknown {
    let copy: Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(input)) {
        const size = utils.sizeof(value)
        if (size > threshold) {
            copy ??= { ...input }
            copy[key] = `(truncated, original size ${formatSize(size)})`
        }
    }
    return copy ?? input
}

// Growth never exceeds the size of what was written, because the journal only replaces a step's
// entry. A loop step is re-written every iteration while carrying every past iteration, so its
// bound is its own shell plus the empty slots it added; each step inside an iteration is counted
// when it is written.
function upsertGrowthBound({ stepName, stepOutput, previous }: Omit<RecordUpsertParams, 'steps'>): number {
    const keyBytes = utils.sizeof(stepName) + 2
    if (stepOutput.type !== FlowActionType.LOOP_ON_ITEMS) {
        return keyBytes + sizeofUtils.recursiveSizeof(stepOutput)
    }
    const iterations = readIterations(stepOutput.output)
    const previousIterations = readIterations(previous?.output)
    const addedSlots = Math.max(0, iterations.length - previousIterations.length)
    const shell = { ...stepOutput, output: { ...readRecord(stepOutput.output), iterations: [] } }
    return keyBytes + sizeofUtils.recursiveSizeof(shell) + addedSlots * EMPTY_ITERATION_BYTES
}

function readIterations(output: unknown): unknown[] {
    const iterations = readRecord(output)['iterations']
    return Array.isArray(iterations) ? iterations : []
}

function readRecord(value: unknown): Record<string, unknown> {
    return isPlainRecord(value) ? value : {}
}

type LogSizeTracker = {
    measuredBytes: number
    growthBoundBytes: number
    upsertsSinceWalk: number
    walkEveryUpserts: number
}

type RecordUpsertParams = {
    steps: Record<string, StepOutput>
    stepName: string
    stepOutput: BaseStepOutput
    previous: StepOutput | undefined
}

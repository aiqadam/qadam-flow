import {
    FlowActionType,
    GenericStepOutput,
    LoopStepOutput,
    StepOutput,
    StepOutputStatus,
} from '@aiqadam/shared'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { StepExecutionPath } from '../../src/lib/handler/context/step-execution-path'
import { loggingUtils } from '../../src/lib/helper/logging-utils'
import { sizeofUtils } from '../../src/lib/helper/sizeof'

describe('loggingUtils.maybeTruncateInput', () => {
    const threshold = 2 * 1024

    it('returns input unchanged when every value is within the threshold', () => {
        const input = { a: 'small', b: { nested: 1 }, c: [1, 2, 3] }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toBe(input)
    })

    it('replaces over-threshold top-level values with a sized placeholder', () => {
        const large = 'x'.repeat(4096)
        const input = { keep: 'small', drop: large }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            keep: 'small',
            drop: expect.stringMatching(/^\(truncated, original size \d+ KB\)$/),
        })
    })

    it('does not recurse into nested objects', () => {
        const large = 'x'.repeat(4096)
        const input = { outer: { inner: large } }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            outer: expect.stringMatching(/^\(truncated, original size \d+ KB\)$/),
        })
    })

    it('uses MB units with one decimal place for values over 1024 KB', () => {
        const large = 'x'.repeat(2 * 1024 * 1024)
        const input = { drop: large }
        const result = loggingUtils.maybeTruncateInput(input, threshold)
        expect(result).toEqual({
            drop: expect.stringMatching(/^\(truncated, original size \d+\.\d MB\)$/),
        })
    })

    it('returns the input unchanged when it is not a plain record', () => {
        expect(loggingUtils.maybeTruncateInput(undefined, threshold)).toBeUndefined()
        expect(loggingUtils.maybeTruncateInput(null, threshold)).toBeNull()
        const arr = [1, 2, 3]
        expect(loggingUtils.maybeTruncateInput(arr, threshold)).toBe(arr)
        expect(loggingUtils.maybeTruncateInput('hello', threshold)).toBe('hello')
    })

    it('does not mutate the original input record', () => {
        const large = 'x'.repeat(4096)
        const input = { keep: 'small', drop: large }
        loggingUtils.maybeTruncateInput(input, threshold)
        expect(input.drop).toBe(large)
    })
})

describe('loggingUtils.isWithinSizeLimit', () => {
    it('returns true when steps fit under the cap', () => {
        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { tiny: 'ok' },
            }),
        }
        expect(loggingUtils.isWithinSizeLimit(steps, 10 * 1024)).toBe(true)
    })

    it('returns false when steps blow the cap', () => {
        const steps = {
            step1: GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: { large: 'x'.repeat(4096) },
            }),
        }
        expect(loggingUtils.isWithinSizeLimit(steps, 128)).toBe(false)
    })
})

// #387: the full walk is skipped only while a measured size plus an upper bound on what was
// written since is provably under the cap; past that it measures again, so the cap still holds.
describe('loggingUtils.isWithinSizeLimit — amortized walk', () => {
    const smallStep = (payload: string): GenericStepOutput<FlowActionType.PIECE, { payload: string }> => GenericStepOutput.create({
        type: FlowActionType.PIECE,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output: { payload },
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not walk the journal again while the bound stays under the cap', () => {
        const steps: Record<string, StepOutput> = {}
        expect(loggingUtils.isWithinSizeLimit(steps, 10 * 1024)).toBe(true)
        const walk = vi.spyOn(sizeofUtils, 'recursiveSizeof')

        for (let i = 0; i < 20; i++) {
            const step = smallStep('x'.repeat(10))
            loggingUtils.recordUpsert({ steps, stepName: `step_${i}`, stepOutput: step, previous: undefined })
            steps[`step_${i}`] = step
            expect(loggingUtils.isWithinSizeLimit(steps, 10 * 1024)).toBe(true)
        }

        const fullWalks = walk.mock.calls.filter(([value]) => value === steps)
        expect(fullWalks).toHaveLength(0)
    })

    it('still reports the cap as exceeded once writes add up past it', () => {
        const steps: Record<string, StepOutput> = {}
        expect(loggingUtils.isWithinSizeLimit(steps, 1024)).toBe(true)

        const results = Array.from({ length: 20 }, (_, i) => {
            const step = smallStep('x'.repeat(100))
            loggingUtils.recordUpsert({ steps, stepName: `step_${i}`, stepOutput: step, previous: undefined })
            steps[`step_${i}`] = step
            return loggingUtils.isWithinSizeLimit(steps, 1024)
        })

        expect(results[0]).toBe(true)
        expect(results[results.length - 1]).toBe(false)
        expect(sizeofUtils.recursiveSizeof(steps)).toBeGreaterThan(1024)
    })

    it('measures a journal it has never seen in full', () => {
        const steps: Record<string, StepOutput> = { big: smallStep('x'.repeat(4096)) }

        expect(loggingUtils.isWithinSizeLimit(steps, 1024)).toBe(false)
    })
})

// The loop branch of the bound is the one that does arithmetic rather than sizing what was written:
// a loop step is re-written every iteration carrying all past iterations. Driven the way
// `loop-executor` drives it, the bound must never come out below the real size.
describe('loggingUtils.isWithinSizeLimit — loop writes', () => {
    it('never reports a journal under its real size while a loop runs', async () => {
        let context = FlowExecutorContext.empty()
        expect(loggingUtils.isWithinSizeLimit(context.steps, 1024 * 1024)).toBe(true)
        let loop = LoopStepOutput.init({ input: { items: 'x'.repeat(100) } })

        for (let i = 0; i < 40; i++) {
            loop = loop.setItemAndIndex({ item: { value: i }, index: i + 1 }).addIteration()
            context = await context.upsertStep('loop', loop)
            context = context.setCurrentPath(StepExecutionPath.empty().loopIteration({ loopName: 'loop', iteration: i }))
            context = await context.upsertStep('inner', GenericStepOutput.create({
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: {},
                output: { payload: 'y'.repeat(50) },
            }))
            context = context.setCurrentPath(StepExecutionPath.empty())

            const realSize = sizeofUtils.recursiveSizeof(context.steps)
            expect(loggingUtils.isWithinSizeLimit(context.steps, realSize - 1)).toBe(false)
            expect(loggingUtils.isWithinSizeLimit(context.steps, 1024 * 1024)).toBe(true)
        }
    })
})

// The bound only sees writes. A qadam that grows an object already in the journal in place is
// caught by a walk on a doubling schedule of writes, and by the walk when the run ends.
describe('loggingUtils.isWithinSizeLimit — objects grown in place', () => {
    const grownInPlace = (): { steps: Record<string, StepOutput>, output: { list: string[] } } => {
        const output = { list: ['small'] }
        const steps: Record<string, StepOutput> = {
            source: GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.SUCCEEDED, input: {}, output }),
        }
        expect(loggingUtils.isWithinSizeLimit(steps, 64 * 1024)).toBe(true)
        output.list.push('x'.repeat(128 * 1024))
        return { steps, output }
    }

    it('catches it on the next scheduled walk', () => {
        const { steps } = grownInPlace()

        const results = Array.from({ length: 300 }, (_, i) => {
            const step = GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.SUCCEEDED, input: {}, output: i })
            loggingUtils.recordUpsert({ steps, stepName: `step_${i}`, stepOutput: step, previous: undefined })
            steps[`step_${i}`] = step
            return loggingUtils.isWithinSizeLimit(steps, 64 * 1024)
        })

        expect(results[0]).toBe(true)
        expect(results[results.length - 1]).toBe(false)
    })

    it('catches it on the walk a finished run does', () => {
        const { steps } = grownInPlace()

        expect(loggingUtils.isWithinSizeLimit(steps, 64 * 1024)).toBe(true)
        expect(loggingUtils.isWithinSizeLimitAfterFullWalk(steps, 64 * 1024)).toBe(false)
    })
})

// A bound that over-counts triggers walks of its own; those must not push the forced schedule out,
// or in-place growth would go unseen for arbitrarily long.
describe('loggingUtils.isWithinSizeLimit — forced schedule', () => {
    it('forces a walk at a fixed write count even after walks the bound caused', () => {
        const output = { list: ['small'] }
        const steps: Record<string, StepOutput> = {
            source: GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.SUCCEEDED, input: {}, output }),
        }
        const cap = 64 * 1024
        expect(loggingUtils.isWithinSizeLimit(steps, cap)).toBe(true)

        const bulky = GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.SUCCEEDED, input: {}, output: 'x'.repeat(8 * 1024) })
        for (let i = 0; i < 40; i++) {
            loggingUtils.recordUpsert({ steps, stepName: 'overwritten', stepOutput: bulky, previous: undefined })
            steps.overwritten = bulky
            expect(loggingUtils.isWithinSizeLimit(steps, cap)).toBe(true)
        }

        output.list.push('x'.repeat(128 * 1024))
        const small = GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.SUCCEEDED, input: {}, output: 1 })
        const results = Array.from({ length: 256 }, () => {
            loggingUtils.recordUpsert({ steps, stepName: 'tick', stepOutput: small, previous: undefined })
            steps.tick = small
            return loggingUtils.isWithinSizeLimit(steps, cap)
        })

        expect(results[results.length - 1]).toBe(false)
    })
})

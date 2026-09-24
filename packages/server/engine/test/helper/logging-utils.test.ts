import {
    FlowActionType,
    GenericStepOutput,
    StepOutput,
    StepOutputStatus,
} from '@aiqadam/shared'
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
    const smallStep = (payload: string) => GenericStepOutput.create({
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

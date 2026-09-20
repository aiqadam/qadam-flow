import { FlowActionType, GenericStepOutput, StepOutputStatus } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { FlowExecutorContext } from '../../../src/lib/handler/context/flow-execution-context'

function createStep(output: unknown) {
    return GenericStepOutput.create({
        type: FlowActionType.CODE,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output,
    })
}

describe('FlowExecutorContext.currentState', () => {
    // Blocking finding: `currentState`'s reduce read `this.steps[stepName]` off a plain `Record`.
    // `STEP_NAME_REGEX` admits `constructor`, and a bare index for a step that never ran resolves
    // it off `Object.prototype` (the `Object` constructor function, truthy) instead of `undefined`
    // — so the truthy check that gates inclusion lets it through, and it surfaces as a bogus key in
    // the variable-resolution scope handed to `{{...}}` expression evaluation. This must fail (an
    // extra `constructor` key, and `state.constructor` not being the real `Object` prototype
    // property) on a bare index and pass with `Object.hasOwn`.
    it('does not resolve a referenced step literally named "constructor" that never ran', async () => {
        let ctx = FlowExecutorContext.empty()
        ctx = await ctx.upsertStep('step_1', createStep({ value: 1 }))

        const state = await ctx.currentState(['constructor', 'step_1'])

        expect(Object.keys(state)).toEqual(['step_1'])
        expect(state.step_1).toEqual({ output: { value: 1 }, error: undefined })
    })

    // Blocking finding: `extractStepView`'s `result[stepName] = {...}` and the reduce's
    // `acc[stepName] = ...` are bracket assignments on plain objects built fresh in this method.
    // `STEP_NAME_REGEX` admits `__proto__`, and assigning to that literal key does not create an
    // own property — it invokes the inherited `Object.prototype.__proto__` setter and silently
    // reassigns the object's own prototype instead, dropping the step from any
    // `Object.keys`/`Object.entries` view of the resolved state even though it did run. Must fail
    // (missing key) on a bracket assignment and pass with `Object.defineProperty`.
    it('resolves a referenced step literally named "__proto__" as a real, visible key', async () => {
        let ctx = FlowExecutorContext.empty()
        ctx = await ctx.upsertStep('__proto__', createStep({ secret: 'value' }))

        const state = await ctx.currentState(['__proto__'])

        expect(Object.keys(state)).toContain('__proto__')
        expect(state['__proto__']).toEqual({ output: { secret: 'value' }, error: undefined })
        expect(Object.getPrototypeOf(state)).toBe(Object.prototype)
    })

    it('resolves every step when no referenced names are given', async () => {
        let ctx = FlowExecutorContext.empty()
        ctx = await ctx.upsertStep('step_1', createStep({ value: 1 }))
        ctx = await ctx.upsertStep('step_2', createStep({ value: 2 }))

        const state = await ctx.currentState()

        expect(Object.keys(state).sort()).toEqual(['step_1', 'step_2'])
    })
})

import { PropertyType, QadamPropertyMap } from '@aiqadam/qadams-framework'
import { describe, expect, it } from 'vitest'
import { stepInputMerge } from '../../../../src/app/mcp/tools/step-input-merge'

const CALL_FLOW_PROPS = {
    flow: { type: PropertyType.DROPDOWN, required: true, displayName: 'Flow' },
    flowProps: { type: PropertyType.DYNAMIC, required: true, displayName: '' },
    waitForResponse: { type: PropertyType.CHECKBOX, required: false, displayName: 'Wait' },
    executionMode: { type: PropertyType.STATIC_DROPDOWN, required: true, displayName: 'Execution Mode' },
} as unknown as QadamPropertyMap

const CURRENT_INPUT = {
    flow: { externalId: 'child-flow' },
    flowProps: { payload: { key: 'greeting', lang: 'ru' } },
    waitForResponse: true,
    executionMode: 'queue',
}

describe('stepInputMerge.mergeDynamicProps', () => {
    it('leaves an unmentioned DYNAMIC prop out of the merge, so the spread keeps the stored value', () => {
        const merged = stepInputMerge.mergeDynamicProps({
            currentInput: CURRENT_INPUT,
            incomingInput: { executionMode: 'inline' },
            props: CALL_FLOW_PROPS,
        })

        expect(merged).toEqual({ executionMode: 'inline' })
    })

    it('merges into a DYNAMIC prop rather than replacing it', () => {
        const merged = stepInputMerge.mergeDynamicProps({
            currentInput: { flowProps: { payload: { a: 1 }, other: 'keep' } },
            incomingInput: { flowProps: { payload: { a: 2 } } },
            props: CALL_FLOW_PROPS,
        })

        expect(merged.flowProps).toEqual({ payload: { a: 2 }, other: 'keep' })
    })

    it('replaces a non-DYNAMIC object prop wholesale, as a plain merge always did', () => {
        const merged = stepInputMerge.mergeDynamicProps({
            currentInput: { flow: { externalId: 'child-flow', stale: true } },
            incomingInput: { flow: { externalId: 'other-flow' } },
            props: CALL_FLOW_PROPS,
        })

        expect(merged.flow).toEqual({ externalId: 'other-flow' })
    })

    it('passes the incoming input through untouched when the qadam metadata could not be resolved', () => {
        const incoming = { flowProps: { payload: { a: 2 } } }

        const merged = stepInputMerge.mergeDynamicProps({
            currentInput: CURRENT_INPUT,
            incomingInput: incoming,
            props: undefined,
        })

        expect(merged).toEqual(incoming)
    })

    it('returns nothing to merge when the caller sent no input', () => {
        expect(stepInputMerge.mergeDynamicProps({
            currentInput: CURRENT_INPUT,
            incomingInput: undefined,
            props: CALL_FLOW_PROPS,
        })).toEqual({})
    })
})

describe('stepInputMerge.findEmptiedRequiredProps', () => {
    it('reports a required DYNAMIC sub-field that held a value and would end up empty', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, flowProps: {} },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual(['flowProps'])
    })

    it('names the sub-field when the prop itself survives but its payload does not', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, flowProps: { payload: {} } },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual(['flowProps.payload'])
    })

    it('reports a required scalar prop that would be cleared', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, executionMode: '' },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual(['executionMode'])
    })

    it('allows overwriting a required prop with a different value', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, flowProps: { payload: { key: 'other' } } },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual([])
    })

    it('ignores an optional prop being cleared', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, waitForResponse: null },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual([])
    })

    it('ignores a required prop that was already empty', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: { ...CURRENT_INPUT, flowProps: {} },
            updatedInput: { ...CURRENT_INPUT, flowProps: {} },
            props: CALL_FLOW_PROPS,
        })

        expect(emptied).toEqual([])
    })

    it('reports nothing when the qadam metadata could not be resolved', () => {
        const emptied = stepInputMerge.findEmptiedRequiredProps({
            currentInput: CURRENT_INPUT,
            updatedInput: { ...CURRENT_INPUT, flowProps: {} },
            props: undefined,
        })

        expect(emptied).toEqual([])
    })
})

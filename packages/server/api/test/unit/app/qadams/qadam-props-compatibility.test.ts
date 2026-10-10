import { describe, expect, it } from 'vitest'
import { qadamPropsCompatibility } from '../../../../src/app/qadams/snapshot-export/qadam-props-compatibility'

// ADR-0004 / ADR-0003: the props check that decides whether a step may move from one version of a
// qadam to another. Gate 2's rules, applied to the one action or trigger a step uses.
const ACTION = { kind: 'action', name: 'insert' } as const

describe('qadamPropsCompatibility.check', () => {
    it('accepts the same props', () => {
        expect(check({ from: { name: text() }, to: { name: text() } })).toEqual({ compatible: true })
    })

    it('accepts an optional prop, and a required prop with a default, added in the later version', () => {
        expect(check({ from: { name: text() }, to: { name: text(), note: text(), mode: text({ required: true, defaultValue: 'a' }) } })).toEqual({ compatible: true })
    })

    it.each([
        ['a prop removed', { name: text(), note: text() }, { name: text() }],
        ['a prop that changed type', { name: text() }, { name: { type: 'NUMBER', required: false } }],
        ['a prop added required with no default', { name: text() }, { name: text(), extra: text({ required: true }) }],
        ['a prop that became required with no default', { name: text() }, { name: text({ required: true }) }],
        ['a prop that lost its default and is now required', { name: text({ required: true, defaultValue: 'a' }) }, { name: text({ required: true }) }],
        ['a dropdown value removed', { mode: dropdown(['a', 'b']) }, { mode: dropdown(['a']) }],
    ])('refuses %s', (_label, from, to) => {
        expect(check({ from, to }).compatible).toBe(false)
    })

    it('accepts a dropdown that gained a value, and a prop that stays required with no default', () => {
        expect(check({ from: { mode: dropdown(['a']), name: text({ required: true }) }, to: { mode: dropdown(['a', 'b']), name: text({ required: true }) } })).toEqual({ compatible: true })
    })

    it('refuses when the later version has no such action, or the earlier one does not describe it', () => {
        expect(qadamPropsCompatibility.check({ from: metadata({ props: {} }), to: { actions: {}, triggers: {} }, target: ACTION }).compatible).toBe(false)
        expect(qadamPropsCompatibility.check({ from: { actions: {}, triggers: {} }, to: metadata({ props: {} }), target: ACTION }).compatible).toBe(false)
    })

    it('refuses metadata it cannot read, rather than guessing', () => {
        expect(qadamPropsCompatibility.check({ from: null, to: metadata({ props: {} }), target: ACTION }).compatible).toBe(false)
        expect(qadamPropsCompatibility.check({ from: metadata({ props: {} }), to: 'x', target: ACTION }).compatible).toBe(false)
        expect(qadamPropsCompatibility.check({ from: metadata({ props: { a: {} } }), to: metadata({ props: {} }), target: ACTION }).compatible).toBe(false)
    })

    it('checks a trigger against triggers, not actions', () => {
        const from = { actions: {}, triggers: { new_row: { props: { a: text() } } } }
        const to = { actions: {}, triggers: { new_row: { props: { a: text() } } } }

        expect(qadamPropsCompatibility.check({ from, to, target: { kind: 'trigger', name: 'new_row' } })).toEqual({ compatible: true })
        expect(qadamPropsCompatibility.check({ from, to, target: { kind: 'action', name: 'new_row' } }).compatible).toBe(false)
    })

    it('ignores another action that changed', () => {
        const from = { actions: { insert: { props: { a: text() } }, other: { props: { b: text() } } }, triggers: {} }
        const to = { actions: { insert: { props: { a: text() } }, other: { props: {} } }, triggers: {} }

        expect(qadamPropsCompatibility.check({ from, to, target: ACTION })).toEqual({ compatible: true })
    })
})

function check({ from, to }: { from: Record<string, unknown>, to: Record<string, unknown> }): { compatible: boolean } {
    return qadamPropsCompatibility.check({ from: metadata({ props: from }), to: metadata({ props: to }), target: ACTION })
}

function metadata({ props }: { props: Record<string, unknown> }): Record<string, unknown> {
    return { actions: { insert: { props } }, triggers: {} }
}

function text({ required = false, defaultValue }: { required?: boolean, defaultValue?: unknown } = {}): Record<string, unknown> {
    return { type: 'SHORT_TEXT', required, ...(defaultValue === undefined ? {} : { defaultValue }) }
}

function dropdown(values: string[]): Record<string, unknown> {
    return { type: 'STATIC_DROPDOWN', required: false, options: { options: values.map((value) => ({ label: value, value })) } }
}

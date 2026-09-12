import { describe, expect, it } from 'vitest'
import { piecePropertiesUtils } from '../../src/lib/property/util'
import { PropertyType } from '../../src/lib/property/input/property-type'
import { QadamPropertyMap } from '../../src/lib/property'

function propsWith(property: unknown): QadamPropertyMap {
    return { mode: property } as unknown as QadamPropertyMap
}

function staticDropdown(options: unknown, required = true) {
    return {
        type: PropertyType.STATIC_DROPDOWN,
        displayName: 'Mode',
        required,
        options,
    }
}

function parse(property: unknown, value: unknown) {
    return piecePropertiesUtils.buildSchema(propsWith(property), undefined, false).safeParse({ mode: value })
}

const TWO_OPTIONS = {
    disabled: false,
    options: [
        { label: 'Queue', value: 'queue' },
        { label: 'Inline', value: 'inline' },
    ],
}

describe('buildSchema — STATIC_DROPDOWN option enforcement', () => {
    it('accepts a declared option value', () => {
        expect(parse(staticDropdown(TWO_OPTIONS), 'inline').success).toBe(true)
    })

    it('rejects a value that is not one of the declared options', () => {
        expect(parse(staticDropdown(TWO_OPTIONS), 'totally-made-up').success).toBe(false)
    })

    it('reports the rejection with a translatable key rather than a raw sentence', () => {
        const result = parse(staticDropdown(TWO_OPTIONS), 'totally-made-up')

        expect(result.success).toBe(false)
        expect(result.error?.issues[0].message).toBe('valueNotInOptions')
    })

    it('accepts a template expression, which is what the prop holds in dynamic mode', () => {
        expect(parse(staticDropdown(TWO_OPTIONS), '{{ step_1[\'output\'].mode }}').success).toBe(true)
    })

    it('still rejects null on a required dropdown', () => {
        expect(parse(staticDropdown(TWO_OPTIONS), null).success).toBe(false)
    })

    it('falls back to the non-null check when the declared option list is empty', () => {
        expect(parse(staticDropdown({ disabled: true, options: [] }), 'anything').success).toBe(true)
    })

    it('matches a numeric option stored as its string spelling', () => {
        const numeric = staticDropdown({ options: [{ label: 'One', value: 1 }] })

        expect(parse(numeric, '1').success).toBe(true)
        expect(parse(numeric, '2').success).toBe(false)
    })

    it('matches an object option regardless of key order', () => {
        const objectOption = staticDropdown({ options: [{ label: 'Child', value: { externalId: 'c1', name: 'child' } }] })

        expect(parse(objectOption, { name: 'child', externalId: 'c1' }).success).toBe(true)
        expect(parse(objectOption, { name: 'child', externalId: 'other' }).success).toBe(false)
    })

    it('leaves an optional dropdown able to be null', () => {
        expect(parse(staticDropdown(TWO_OPTIONS, false), null).success).toBe(true)
    })

    it('leaves DROPDOWN on the non-null check, since its options resolve at run time', () => {
        const dynamicDropdown = {
            type: PropertyType.DROPDOWN,
            displayName: 'Flow',
            required: true,
            refreshers: [],
            options: async () => ({ options: [] }),
        }

        expect(parse(dynamicDropdown, 'anything-at-all').success).toBe(true)
        expect(parse(dynamicDropdown, null).success).toBe(false)
    })
})

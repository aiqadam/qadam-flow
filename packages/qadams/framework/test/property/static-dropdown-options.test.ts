import { describe, expect, it } from 'vitest'
import { piecePropertiesUtils } from '../../src/lib/property/util'
import { PropertyType } from '../../src/lib/property/input/property-type'
import { QadamPropertyMap } from '../../src/lib/property'

function propsWith(property: unknown): QadamPropertyMap {
    return { mode: property } as unknown as QadamPropertyMap
}

function staticDropdown(options: unknown, required = true, defaultValue?: unknown) {
    return {
        type: PropertyType.STATIC_DROPDOWN,
        displayName: 'Mode',
        required,
        options,
        ...(defaultValue === undefined ? {} : { defaultValue }),
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

    it('accepts an empty string, which is what the builder stores when a dropdown is toggled to dynamic mode', () => {
        // `getDefaultPropertyValue` returns '' for a dropdown in dynamic-input mode, before any
        // expression has been typed. Rejecting it would make the field invalid the moment the
        // author flips the toggle — a state that was valid before this check existed.
        expect(parse(staticDropdown(TWO_OPTIONS), '').success).toBe(true)
    })

    it('accepts the prop\'s own defaultValue even when it is absent from the option list', () => {
        // @aiqadam/qadam-nocodb declares `version` with defaultValue 0 against options 1..4, and the
        // connection dialog seeds the form from defaultValue — so rejecting it would block creating
        // a NocoDB connection entirely.
        const nocodbVersion = staticDropdown({
            options: [1, 2, 3, 4].map(value => ({ label: `v${value}`, value })),
        }, false, 0)

        expect(parse(nocodbVersion, 0).success).toBe(true)
        expect(parse(nocodbVersion, 99).success).toBe(false)
    })

    it('accepts a defaultValue whose case differs from the declared options', () => {
        // @aiqadam/qadam-clickup's channel `visibility` defaults to 'public' against 'PUBLIC'/'PRIVATE'.
        const clickupVisibility = staticDropdown({
            options: [
                { label: 'Public', value: 'PUBLIC' },
                { label: 'Private', value: 'PRIVATE' },
            ],
        }, true, 'public')

        expect(parse(clickupVisibility, 'public').success).toBe(true)
        expect(parse(clickupVisibility, 'protected').success).toBe(false)
    })

    it('rejects a large value against primitive-only options without walking it', () => {
        // The `timezone` dropdown of @aiqadam/qadam-schedule declares 419 primitive options. Comparing
        // the submitted value against each one in turn used to re-serialise it 419 times, which is
        // seconds of non-yielding work on the API's single thread for a multi-megabyte value.
        const manyOptions = staticDropdown({
            options: Array.from({ length: 419 }, (_, index) => ({ label: `tz-${index}`, value: `tz-${index}` })),
        })
        const hugeValue = Array.from({ length: 200_000 }, (_, index) => `x-${index}`)

        const startedAt = process.hrtime.bigint()
        const result = parse(manyOptions, hugeValue)
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

        expect(result.success).toBe(false)
        expect(elapsedMs).toBeLessThan(250)
    })

    it('rejects a deeply nested value rather than throwing out of the refinement', () => {
        // zod re-throws whatever a refinement throws rather than turning it into a validation
        // failure, so an unguarded recursion would surface as a 500 on flow update. Confirmed
        // load-bearing: with MAX_OPTION_DEPTH raised out of the way this case throws
        // `RangeError: Maximum call stack size exceeded` on Node 26.
        const objectOption = staticDropdown({ options: [{ label: 'Child', value: { externalId: 'c1' } }] })
        let nested: unknown = 'leaf'
        for (let depth = 0; depth < 100_000; depth++) {
            nested = [nested]
        }

        expect(() => parse(objectOption, nested)).not.toThrow()
        expect(parse(objectOption, nested).success).toBe(false)
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

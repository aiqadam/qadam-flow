import { describe, expect, it } from 'vitest'
import { DropdownOption } from '../../src/lib/property/input/dropdown/common'
import { PropertyType } from '../../src/lib/property/input/property-type'
import { piecePropertiesUtils } from '../../src/lib/property/util'
import { QadamPropertyMap } from '../../src/lib/property'
import { TriggerBase } from '../../src/lib/qadam-metadata'

// JSON drops `undefined`-valued keys. zod 4.3 accepted a missing key for a bare `z.unknown()`;
// zod 4.6 rejects it unless the field is `.optional()` (#949). These framework schemas must keep
// accepting the shape that arrives after a JSON hop.
describe('framework schemas with an undefined-able field', () => {
    it('accepts a dropdown option whose value was undefined', () => {
        expect(DropdownOption.safeParse(jsonRoundTrip({ label: 'None', value: undefined })).success).toBe(true)
    })

    it('accepts trigger metadata without sample data', () => {
        expect(TriggerBase.pick({ sampleData: true }).safeParse(jsonRoundTrip({ sampleData: undefined })).success).toBe(true)
    })

    it('accepts a required Custom prop with no value, as it did before the zod update', () => {
        const props = { widget: { type: PropertyType.CUSTOM, displayName: 'Widget', required: true } } as unknown as QadamPropertyMap

        const result = piecePropertiesUtils.buildSchema(props, undefined, false).safeParse(jsonRoundTrip({ widget: undefined }))

        expect(result.success).toBe(true)
    })
})

function jsonRoundTrip(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}

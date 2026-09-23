import { isOfficialQadamName } from '../../../src/lib/automation/qadams/utils'

describe('isOfficialQadamName', () => {
    it('recognises a name in the @aiqadam scope', () => {
        expect(isOfficialQadamName('@aiqadam/qadam-slack')).toBe(true)
    })

    it('ignores case, since an uploaded archive can carry a name npm would refuse', () => {
        expect(isOfficialQadamName('@AIQADAM/qadam-slack')).toBe(true)
    })

    it('does not match a lookalike scope', () => {
        expect(isOfficialQadamName('@aiqadam-x/qadam-slack')).toBe(false)
        expect(isOfficialQadamName('@aiqadamx/qadam-slack')).toBe(false)
    })

    it('does not match the bare scope or an unscoped name', () => {
        expect(isOfficialQadamName('@aiqadam')).toBe(false)
        expect(isOfficialQadamName('qadam-slack')).toBe(false)
        expect(isOfficialQadamName('aiqadam/qadam-slack')).toBe(false)
    })
})

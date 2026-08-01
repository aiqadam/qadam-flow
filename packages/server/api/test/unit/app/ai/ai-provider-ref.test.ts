import { AIProviderName, apId, ApId } from '@aiqadam/shared'

// `/v1/ai-providers/:providerRef/{config,models}` accepts either a row id or a provider name, and
// resolves the two by shape. That is only safe while the two sets are disjoint — so this is the
// contract, not a curiosity. If a future AIProviderName is ever 21 alphanumeric characters, the
// route stops being able to tell a name from an id and this test is what says so.
describe('AI provider reference forms', () => {
    it('should have no provider name that could be mistaken for a row id', () => {
        const namesParsingAsId = Object.values(AIProviderName).filter(name => ApId.safeParse(name).success)

        expect(namesParsingAsId).toEqual([])
    })

    it('should generate ids that are never a provider name', () => {
        const names: string[] = Object.values(AIProviderName)
        const ids = Array.from({ length: 200 }, () => apId())

        expect(ids.filter(id => names.includes(id))).toEqual([])
        expect(ids.every(id => ApId.safeParse(id).success)).toBe(true)
    })
})

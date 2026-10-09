import { ListQadamsRequestQuery, RegistryQadamsRequestQuery } from '../../src/lib/automation/qadams/dto/qadam-requests'

// ADR-0001 / #798: images built from `main` report `<next>-main.<n>`, and the builder sends that
// version as `release` to GET /v1/qadams/registry. Before #798 the query only took `x.y.z`, so every
// `main` image answered the builder's version list with 400.
describe('the platform release in qadam queries', () => {
    it.each([
        ['1.1.0', 'a release'],
        ['2.0.0-main.1234', 'a main build'],
        ['2.1.0-main.0', 'a main build with counter 0'],
        ['2.1.0-rc.1', 'a release-candidate tag'],
        ['2.1.0-alpha-1.x.7', 'hyphens and alphanumeric identifiers'],
    ])('accepts %s (%s)', (release) => {
        expect(RegistryQadamsRequestQuery.safeParse({ release }).success).toBe(true)
        expect(ListQadamsRequestQuery.safeParse({ release }).success).toBe(true)
    })

    it.each([
        ['2.1.0-main.05', 'a numeric identifier with a leading zero'],
        ['2.1.0-', 'an empty prerelease'],
        ['2.1.0-main..5', 'an empty identifier'],
        ['2.1.0+sha.abc', 'build metadata'],
        ['2.1.0-main.5+sha', 'a prerelease with build metadata'],
        ['v2.1.0', 'a tag name'],
        ['2.1', 'two components'],
        ['^2.1.0', 'a range'],
        ['2.1.0-main.5\n', 'a trailing newline'],
    ])('rejects %j (%s)', (release) => {
        expect(RegistryQadamsRequestQuery.safeParse({ release }).success).toBe(false)
        expect(ListQadamsRequestQuery.safeParse({ release }).success).toBe(false)
    })

    it('keeps release required on the registry query and optional on the list query', () => {
        expect(RegistryQadamsRequestQuery.safeParse({}).success).toBe(false)
        expect(ListQadamsRequestQuery.safeParse({}).success).toBe(true)
    })
})

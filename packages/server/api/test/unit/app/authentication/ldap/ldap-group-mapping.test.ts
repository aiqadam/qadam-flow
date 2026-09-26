import { DefaultProjectRole, LdapGroupMapping, PlatformRole } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { ldapGroupMappingUtils } from '../../../../../src/app/authentication/ldap/ldap-group-mapping'

function mapping(overrides: Partial<LdapGroupMapping> & { groupDn: string }): LdapGroupMapping {
    return { platformRole: undefined, projects: [], ...overrides }
}

describe('ldapGroupMappingUtils.resolveGrants — platform role', () => {
    it('resolves the highest matched platform role (ADMIN > OPERATOR > MEMBER)', () => {
        const groupMappings = [
            mapping({ groupDn: 'cn=members,dc=example,dc=com', platformRole: PlatformRole.MEMBER }),
            mapping({ groupDn: 'cn=operators,dc=example,dc=com', platformRole: PlatformRole.OPERATOR }),
            mapping({ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN }),
        ]
        const memberGroupDns = ['cn=members,dc=example,dc=com', 'cn=operators,dc=example,dc=com', 'cn=admins,dc=example,dc=com']

        const { platformRole } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns })

        expect(platformRole).toBe(PlatformRole.ADMIN)
    })

    it('leaves platformRole null when no group matches', () => {
        const groupMappings = [mapping({ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN })]

        const { platformRole } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns: ['cn=other,dc=example,dc=com'] })

        expect(platformRole).toBeNull()
    })

    it('leaves platformRole null when every matched mapping carries no platformRole at all', () => {
        const groupMappings = [mapping({ groupDn: 'cn=members,dc=example,dc=com' })]

        const { platformRole } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns: ['cn=members,dc=example,dc=com'] })

        expect(platformRole).toBeNull()
    })

    it('compares group DNs case-insensitively and tolerant of surrounding/inter-component whitespace', () => {
        const groupMappings = [mapping({ groupDn: 'CN=Admins, DC=Example, DC=Com', platformRole: PlatformRole.ADMIN })]

        const { platformRole } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns: ['cn=admins,dc=example,dc=com'] })

        expect(platformRole).toBe(PlatformRole.ADMIN)
    })
})

describe('ldapGroupMappingUtils.resolveGrants — project roles', () => {
    it('resolves the highest matched role per project across multiple matching mappings', () => {
        const groupMappings = [
            mapping({ groupDn: 'cn=viewers,dc=example,dc=com', projects: [{ projectId: 'proj_1', role: DefaultProjectRole.VIEWER }] }),
            mapping({ groupDn: 'cn=admins,dc=example,dc=com', projects: [{ projectId: 'proj_1', role: DefaultProjectRole.ADMIN }] }),
        ]
        const memberGroupDns = ['cn=viewers,dc=example,dc=com', 'cn=admins,dc=example,dc=com']

        const { projectRoles } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns })

        expect(projectRoles.get('proj_1')).toBe(DefaultProjectRole.ADMIN)
    })

    it('only includes projects named by a matched mapping', () => {
        const groupMappings = [
            mapping({ groupDn: 'cn=matched,dc=example,dc=com', projects: [{ projectId: 'proj_1', role: DefaultProjectRole.EDITOR }] }),
            mapping({ groupDn: 'cn=unmatched,dc=example,dc=com', projects: [{ projectId: 'proj_2', role: DefaultProjectRole.EDITOR }] }),
        ]

        const { projectRoles } = ldapGroupMappingUtils.resolveGrants({ groupMappings, memberGroupDns: ['cn=matched,dc=example,dc=com'] })

        expect(projectRoles.size).toBe(1)
        expect(projectRoles.get('proj_1')).toBe(DefaultProjectRole.EDITOR)
        expect(projectRoles.has('proj_2')).toBe(false)
    })
})

// Round 2 (app-sec finding #1): `normalizeGroupDn` used to be a naive
// `.trim().toLowerCase().split(',')`, which is a privilege-escalation hole — these cases each
// exercise one concrete way a spoofed DN could otherwise slip past it and compare equal to a real
// group, per the design comment on `normalizeGroupDn` in `ldap-group-mapping.ts`.
describe('ldapGroupMappingUtils.normalizeGroupDn — RFC 4514 tokenisation (round 2 hardening)', () => {
    it('does NOT treat an escaped comma followed by a space the same as one immediately followed by the next char', () => {
        // Both DNs have a single RDN whose value contains a literal (escaped) comma. Naive
        // `.split(',')` would cut both of these into an extra bogus component at the escaped
        // comma and normalize them to the same thing; the escaped comma must stay part of the
        // value, and the space right after it inside the value is significant, not
        // boundary whitespace to be trimmed.
        const withSpace = ldapGroupMappingUtils.normalizeGroupDn('cn=Foo\\, EU,dc=example,dc=com')
        const withoutSpace = ldapGroupMappingUtils.normalizeGroupDn('cn=Foo\\,EU,dc=example,dc=com')

        expect(withSpace).not.toBe(withoutSpace)
    })

    it('does NOT match a group name with a trailing NBSP against the plain-ASCII name', () => {
        // `String#trim()` strips U+00A0 (NBSP) along with real whitespace; a naive normalizer
        // would silently equate a spoofed "Admins " group with the real "Admins" group.
        const spoofed = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins ,dc=example,dc=com')
        const real = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins,dc=example,dc=com')

        expect(spoofed).not.toBe(real)
    })

    it('does NOT match a group name built with a Kelvin sign (U+212A) against the plain-ASCII "K"', () => {
        // `String#toLowerCase()` performs full Unicode case folding, which maps U+212A KELVIN
        // SIGN onto ASCII "k" — a naive normalizer would equate "Kelvin" with "kelvin".
        const spoofed = ldapGroupMappingUtils.normalizeGroupDn('cn=Kelvin,dc=example,dc=com')
        const real = ldapGroupMappingUtils.normalizeGroupDn('cn=Kelvin,dc=example,dc=com')

        expect(spoofed).not.toBe(real)
    })

    it('DOES match genuine case and spacing differences on attribute types and separators', () => {
        const withMixedCaseAndSpacing = ldapGroupMappingUtils.normalizeGroupDn('CN=Admins, DC=Example, DC=Com')
        const canonical = ldapGroupMappingUtils.normalizeGroupDn('cn=admins,dc=example,dc=com')

        expect(withMixedCaseAndSpacing).toBe(canonical)
    })
})

// Round 3 (app-sec): round 2's tokeniser still flattened the parsed DN back into one joined
// string, which loses exactly the structural information (RDN boundary vs. multi-valued-RDN
// boundary, escaped separator vs. real one) that made the tokenising worthwhile in the first place
// — two structurally different DNs could still normalize to the identical string. `normalizeGroupDn`
// now compares a structured, JSON-serialised form instead; these cases are each a DN pair that a
// flattened comparison could not tell apart.
describe('ldapGroupMappingUtils.normalizeGroupDn — structured comparison (round 3 hardening)', () => {
    it('does NOT equate an escaped comma inside one RDN\'s value with two real, separate RDNs', () => {
        const oneRdnWithEmbeddedComma = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins\\,ou=QadamFlow,ou=Groups,dc=corp,dc=com')
        const twoRealRdns = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins,ou=QadamFlow,ou=Groups,dc=corp,dc=com')

        expect(oneRdnWithEmbeddedComma).not.toBe(twoRealRdns)
    })

    it('does NOT equate a hex-escaped comma+equals inside one RDN\'s value with the real, fully-split DN', () => {
        // `\2C` is the hex escape for `,` (0x2C) and `\3D` is the hex escape for `=` (0x3D) — this
        // still resolves to a single `cn` value containing a literal comma and equals sign, the
        // same shape as the plain-`\,`-escaped case above, and must still differ from the DN that
        // actually splits into five separate RDNs.
        const hexEscapedWithinOneRdn = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins\\2Cou\\3DQadamFlow,ou=Groups,dc=corp,dc=com')
        const twoRealRdns = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins,ou=QadamFlow,ou=Groups,dc=corp,dc=com')

        expect(hexEscapedWithinOneRdn).not.toBe(twoRealRdns)
    })

    it('does NOT equate a multi-valued RDN (`+`) with two separate single-valued RDNs (`,`)', () => {
        const multiValuedRdn = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins+ou=Groups,dc=x')
        const twoSeparateRdns = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins,ou=Groups,dc=x')

        expect(multiValuedRdn).not.toBe(twoSeparateRdns)
    })

    it('does NOT equate a trailing escaped space with a trailing escaped backslash', () => {
        const trailingEscapedSpace = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins\\ ,dc=x')
        const trailingEscapedBackslash = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins\\\\,dc=x')

        expect(trailingEscapedSpace).not.toBe(trailingEscapedBackslash)
    })

    it('decodes a multi-byte UTF-8 hex escape as one character, matching the real character and NOT the byte-by-byte mojibake', () => {
        const hexEscaped = ldapGroupMappingUtils.normalizeGroupDn('cn=\\C3\\A9,dc=x')
        const realCharacter = ldapGroupMappingUtils.normalizeGroupDn('cn=é,dc=x')
        const byteByByteMojibake = ldapGroupMappingUtils.normalizeGroupDn('cn=Ã©,dc=x')

        expect(hexEscaped).toBe(realCharacter)
        expect(hexEscaped).not.toBe(byteByByteMojibake)
    })

    it('does NOT match a group name built with a dotless ı (U+0131) against the plain-ASCII "i"', () => {
        const spoofed = ldapGroupMappingUtils.normalizeGroupDn('cn=admıns,dc=example,dc=com')
        const real = ldapGroupMappingUtils.normalizeGroupDn('cn=admins,dc=example,dc=com')

        expect(spoofed).not.toBe(real)
    })

    it('still DOES match genuine case and spacing differences with the structured comparison', () => {
        const withMixedCaseAndSpacing = ldapGroupMappingUtils.normalizeGroupDn('CN=Admins, DC=Example, DC=Com')
        const canonical = ldapGroupMappingUtils.normalizeGroupDn('cn=admins,dc=example,dc=com')

        expect(withMixedCaseAndSpacing).toBe(canonical)
    })

    it('still normalizes a multi-valued RDN order-independently', () => {
        const orderA = ldapGroupMappingUtils.normalizeGroupDn('cn=Admins+ou=Groups,dc=x')
        const orderB = ldapGroupMappingUtils.normalizeGroupDn('ou=Groups+cn=Admins,dc=x')

        expect(orderA).toBe(orderB)
    })
})

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

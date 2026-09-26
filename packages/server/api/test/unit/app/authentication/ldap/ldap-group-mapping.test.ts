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

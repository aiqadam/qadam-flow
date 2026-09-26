import { describe, expect, it } from 'vitest'
import {
    LdapConfig,
    LdapTlsMode,
    MAX_LDAP_GROUP_DN_LENGTH,
    MAX_LDAP_GROUP_MAPPING_PROJECTS,
    MAX_LDAP_GROUP_MAPPINGS,
    MAX_LDAP_SESSION_TTL_SECONDS,
    MIN_LDAP_SESSION_TTL_SECONDS,
    UpsertLdapConfigRequest,
    UpsertLdapGroupMapping,
} from '../../../src'

const validAttributeMap = {
    subject: 'objectGUID',
    email: 'mail',
    firstName: 'givenName',
    lastName: 'sn',
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        url: 'ldaps://ldap.example.com:636',
        tlsMode: LdapTlsMode.LDAPS,
        baseDn: 'dc=example,dc=com',
        bindDn: 'cn=service,dc=example,dc=com',
        userFilter: '(uid={username})',
        attributeMap: validAttributeMap,
        ...overrides,
    }
}

describe('LdapConfig', () => {
    it('accepts a well-formed LDAPS config', () => {
        const result = LdapConfig.safeParse(baseConfig())
        expect(result.success).toBe(true)
    })

    describe('userFilter placeholder', () => {
        it('rejects a filter with zero occurrences of {username}', () => {
            const result = LdapConfig.safeParse(baseConfig({ userFilter: '(uid=fixed)' }))
            expect(result.success).toBe(false)
        })

        it('rejects a filter with two occurrences of {username}', () => {
            const result = LdapConfig.safeParse(baseConfig({
                userFilter: '(|(uid={username})(mail={username}))',
            }))
            expect(result.success).toBe(false)
        })

        it('accepts a filter with exactly one occurrence of {username}', () => {
            const result = LdapConfig.safeParse(baseConfig({ userFilter: '(uid={username})' }))
            expect(result.success).toBe(true)
        })
    })

    describe('plaintext rejection', () => {
        it('rejects ldap:// when tlsMode is ldaps', () => {
            const result = LdapConfig.safeParse(baseConfig({
                url: 'ldap://ldap.example.com:389',
                tlsMode: LdapTlsMode.LDAPS,
            }))
            expect(result.success).toBe(false)
        })

        it('rejects ldaps:// when tlsMode is starttls', () => {
            const result = LdapConfig.safeParse(baseConfig({
                url: 'ldaps://ldap.example.com:636',
                tlsMode: LdapTlsMode.STARTTLS,
            }))
            expect(result.success).toBe(false)
        })

        it('accepts ldap:// paired with starttls', () => {
            const result = LdapConfig.safeParse(baseConfig({
                url: 'ldap://ldap.example.com:389',
                tlsMode: LdapTlsMode.STARTTLS,
            }))
            expect(result.success).toBe(true)
        })

        it('has no tlsMode value that permits a bare ldap:// URL to reach connect() unupgraded', () => {
            // Every enum member is exercised against the same plaintext URL — if a third tlsMode
            // value were ever added without updating `matchesTlsScheme`, this fails loudly rather
            // than silently accepting an unencrypted config.
            for (const tlsMode of Object.values(LdapTlsMode)) {
                const result = LdapConfig.safeParse(baseConfig({ url: 'ldap://ldap.example.com:389', tlsMode }))
                if (tlsMode !== LdapTlsMode.STARTTLS) {
                    expect(result.success).toBe(false)
                }
            }
        })
    })

    describe('sessionTtlSeconds bounds', () => {
        it('rejects a value below the 1-hour floor', () => {
            const result = LdapConfig.safeParse(baseConfig({ sessionTtlSeconds: MIN_LDAP_SESSION_TTL_SECONDS - 1 }))
            expect(result.success).toBe(false)
        })

        it('rejects a value above the 7-day ceiling', () => {
            const result = LdapConfig.safeParse(baseConfig({ sessionTtlSeconds: MAX_LDAP_SESSION_TTL_SECONDS + 1 }))
            expect(result.success).toBe(false)
        })

        it('accepts the documented default', () => {
            const result = LdapConfig.safeParse(baseConfig())
            expect(result.success).toBe(true)
            if (result.success) {
                expect(result.data.sessionTtlSeconds).toBe(43200)
            }
        })
    })
})

describe('UpsertLdapConfigRequest — omitted defaulted fields stay undefined', () => {
    // `ldapConfigService.upsert` merges `{ ...existing?.config, ...request }` on the promise that
    // an omitted field in `request` keeps the stored value. That promise only holds if `.parse()`
    // actually leaves an omitted field as `undefined` — in this zod version, `.optional()` layered
    // on top of a field's own `.default(...)` does *not* achieve that; the default still fires. All
    // five of these fields must therefore be redefined without their own `.default()` in this
    // schema specifically (`LdapConfig`, used for a brand-new/fully-merged config, keeps its
    // defaults — this is about the partial-update request only).
    const fieldsWithABaseDefault = ['tlsVerify', 'jitProvisioning', 'linkExistingByEmail', 'sessionTtlSeconds', 'enabled'] as const

    it.each(fieldsWithABaseDefault)('omitting %s parses to undefined, not its LdapConfig default', (field) => {
        const result = UpsertLdapConfigRequest.safeParse(baseConfig())
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data[field]).toBeUndefined()
        }
    })

    it('still accepts and preserves an explicitly-sent value for each of those fields', () => {
        const result = UpsertLdapConfigRequest.safeParse(baseConfig({
            tlsVerify: false,
            jitProvisioning: false,
            linkExistingByEmail: true,
            sessionTtlSeconds: 7200,
            enabled: true,
        }))
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data.tlsVerify).toBe(false)
            expect(result.data.jitProvisioning).toBe(false)
            expect(result.data.linkExistingByEmail).toBe(true)
            expect(result.data.sessionTtlSeconds).toBe(7200)
            expect(result.data.enabled).toBe(true)
        }
    })

    it('still enforces the sessionTtlSeconds bounds when it is explicitly sent', () => {
        const result = UpsertLdapConfigRequest.safeParse(baseConfig({ sessionTtlSeconds: MIN_LDAP_SESSION_TTL_SECONDS - 1 }))
        expect(result.success).toBe(false)
    })
})

describe('UpsertLdapGroupMapping', () => {
    it('rejects a mapping with no projects field at all — the request must always supply it', () => {
        const result = UpsertLdapGroupMapping.safeParse({ groupDn: 'cn=admins,dc=example,dc=com', platformRole: 'ADMIN' })
        expect(result.success).toBe(false)
    })

    it('accepts a mapping with an explicit, empty projects array', () => {
        const result = UpsertLdapGroupMapping.safeParse({ groupDn: 'cn=admins,dc=example,dc=com', projects: [] })
        expect(result.success).toBe(true)
    })

    it('rejects a groupDn over the length cap', () => {
        const result = UpsertLdapGroupMapping.safeParse({ groupDn: 'a'.repeat(MAX_LDAP_GROUP_DN_LENGTH + 1), projects: [] })
        expect(result.success).toBe(false)
    })

    it('rejects more projects than the per-mapping cap', () => {
        const projects = Array.from({ length: MAX_LDAP_GROUP_MAPPING_PROJECTS + 1 }, (_, i) => ({ projectId: `proj_${i}`, role: 'VIEWER' as const }))
        const result = UpsertLdapGroupMapping.safeParse({ groupDn: 'cn=admins,dc=example,dc=com', projects })
        expect(result.success).toBe(false)
    })
})

describe('LdapConfig.groupMappings size cap', () => {
    it('rejects more group mappings than the platform-wide cap', () => {
        const groupMappings = Array.from({ length: MAX_LDAP_GROUP_MAPPINGS + 1 }, (_, i) => ({ groupDn: `cn=group${i},dc=example,dc=com`, projects: [] }))
        const result = LdapConfig.safeParse(baseConfig({ groupMappings }))
        expect(result.success).toBe(false)
    })

    it('accepts exactly the cap', () => {
        const groupMappings = Array.from({ length: MAX_LDAP_GROUP_MAPPINGS }, (_, i) => ({ groupDn: `cn=group${i},dc=example,dc=com`, projects: [] }))
        const result = LdapConfig.safeParse(baseConfig({ groupMappings }))
        expect(result.success).toBe(true)
    })
})

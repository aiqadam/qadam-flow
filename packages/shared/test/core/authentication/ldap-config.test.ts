import { describe, expect, it } from 'vitest'
import { LdapConfig, LdapTlsMode, MAX_LDAP_SESSION_TTL_SECONDS, MIN_LDAP_SESSION_TTL_SECONDS } from '../../../src'

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

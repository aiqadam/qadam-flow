import { describe, expect, it } from 'vitest'
import { ldapFilterUtils } from '../../../../../src/app/authentication/ldap/ldap-filter'

describe('ldapFilterUtils', () => {
    describe('escapeFilterValue', () => {
        it('escapes every RFC 4515 metacharacter', () => {
            expect(ldapFilterUtils.escapeFilterValue('\\')).toBe('\\5c')
            expect(ldapFilterUtils.escapeFilterValue('*')).toBe('\\2a')
            expect(ldapFilterUtils.escapeFilterValue('(')).toBe('\\28')
            expect(ldapFilterUtils.escapeFilterValue(')')).toBe('\\29')
            expect(ldapFilterUtils.escapeFilterValue('\u0000')).toBe('\\00')
        })

        it('leaves an ordinary username untouched', () => {
            expect(ldapFilterUtils.escapeFilterValue('jdoe')).toBe('jdoe')
        })

        // The classic filter-injection payload: closes the enclosing `(uid=...)` term early and
        // opens a second term that always matches, turning "exactly one entry" into "every entry".
        it('neutralizes the classic filter-injection payload', () => {
            const escaped = ldapFilterUtils.escapeFilterValue(')(uid=*')
            expect(escaped).toBe('\\29\\28uid=\\2a')
            expect(escaped).not.toContain('(')
            expect(escaped).not.toContain(')')
            expect(escaped).not.toContain('*')
        })

        it('escapes a bare wildcard so it cannot become a match-all', () => {
            expect(ldapFilterUtils.escapeFilterValue('*')).not.toBe('*')
        })
    })

    describe('buildUserSearchFilter', () => {
        it('substitutes the escaped username into the placeholder', () => {
            const filter = ldapFilterUtils.buildUserSearchFilter({
                userFilter: '(uid={username})',
                username: 'jdoe',
            })
            expect(filter).toBe('(uid=jdoe)')
        })

        it('escapes an injected value before substitution, keeping the filter well-formed', () => {
            const filter = ldapFilterUtils.buildUserSearchFilter({
                userFilter: '(uid={username})',
                username: ')(uid=*',
            })
            expect(filter).toBe('(uid=\\29\\28uid=\\2a)')
            // Exactly one opening and one closing paren — the ones the template itself supplies.
            expect(filter.split('(').length - 1).toBe(1)
            expect(filter.split(')').length - 1).toBe(1)
        })
    })
})

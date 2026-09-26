import { describe, expect, it } from 'vitest'
import { ldapUsernameUtils } from '../../../../../src/app/authentication/ldap/ldap-username'

describe('ldapUsernameUtils.normalize', () => {
    it('trims outer whitespace', () => {
        expect(ldapUsernameUtils.normalize('  jdoe  ')).toBe('jdoe')
    })

    it('collapses repeated internal whitespace to a single space', () => {
        expect(ldapUsernameUtils.normalize('j   doe')).toBe('j doe')
    })

    it('lowercases the username', () => {
        expect(ldapUsernameUtils.normalize('JDoe')).toBe('jdoe')
    })

    it('folds a full-width Unicode variant to its canonical form via NFKC', () => {
        // U+FF4A..U+FF45 is the fullwidth form of "jdoe" — visually distinct, same identity to a
        // directory (and to the rate limiter) once NFKC-normalized.
        const fullWidth = 'ｊｄｏｅ'
        expect(ldapUsernameUtils.normalize(fullWidth)).toBe('jdoe')
    })

    it('produces the same value for every rate-limit-and-search-equivalent spelling', () => {
        const variants = ['jdoe', ' jdoe ', 'JDOE', 'ｊｄｏｅ']
        const normalized = new Set(variants.map((variant) => ldapUsernameUtils.normalize(variant)))
        expect(normalized.size).toBe(1)
        expect([...normalized][0]).toBe('jdoe')
    })
})

import { describe, expect, it } from 'vitest'
import { ldapAttributeUtils } from '../../../../../src/app/authentication/ldap/ldap-attributes'

describe('ldapAttributeUtils.objectGuidBufferToCanonicalString', () => {
    // A hand-derived known vector, not copied from any online example: for the canonical GUID
    // `12345678-1234-5678-9abc-def012345678`, AD's on-the-wire `objectGUID` byte-swaps the first
    // three groups (little-endian on the wire, printed big-endian in the canonical string) and
    // leaves the last two groups untouched. Reversing that construction gives the exact 16-byte
    // buffer this test feeds in, so the assertion is checking the real conversion, not a value the
    // function itself produced.
    it('converts a known raw objectGUID buffer to its canonical mixed-endian string form', () => {
        const buffer = Buffer.from('78563412341278569abcdef012345678', 'hex')
        expect(ldapAttributeUtils.objectGuidBufferToCanonicalString(buffer)).toBe('12345678-1234-5678-9abc-def012345678')
    })

    it('round-trips an all-zero GUID', () => {
        const buffer = Buffer.alloc(16, 0)
        expect(ldapAttributeUtils.objectGuidBufferToCanonicalString(buffer)).toBe('00000000-0000-0000-0000-000000000000')
    })
})

describe('ldapAttributeUtils.readStringAttribute — case-insensitive lookup', () => {
    it('finds an attribute whose key case differs from the configured name', () => {
        const entry = { dn: 'uid=jdoe,dc=example,dc=com', Mail: 'jdoe@example.com' }
        expect(ldapAttributeUtils.readStringAttribute({ entry, name: 'mail' })).toBe('jdoe@example.com')
    })

    it('still returns undefined when no key matches, even case-insensitively', () => {
        const entry = { dn: 'uid=jdoe,dc=example,dc=com' }
        expect(ldapAttributeUtils.readStringAttribute({ entry, name: 'mail' })).toBeUndefined()
    })
})

describe('ldapAttributeUtils.resolveSubject — case-insensitive objectGUID lookup', () => {
    it('finds objectGUID even when the directory echoes it back in a different case', () => {
        const buffer = Buffer.from('78563412341278569abcdef012345678', 'hex')
        const entry = { dn: 'uid=jdoe,dc=example,dc=com', ObjectGuid: buffer }
        expect(ldapAttributeUtils.resolveSubject({
            entry,
            attributeMap: { subject: 'objectGUID', email: 'mail', firstName: 'givenName', lastName: 'sn' },
        })).toBe('12345678-1234-5678-9abc-def012345678')
    })

    // A directory bug, a mismapped attribute, or an object class that reuses the name for something
    // else entirely could all put a buffer of the wrong length behind `objectGUID` — slicing/padding
    // that into a GUID-shaped string would fabricate an identifier rather than correctly reporting
    // "no usable subject" (the same outcome a missing attribute gets).
    it('treats a non-16-byte objectGUID buffer as no subject at all, not a malformed one', () => {
        const entry = { dn: 'uid=jdoe,dc=example,dc=com', objectGUID: Buffer.alloc(15, 1) }
        expect(ldapAttributeUtils.resolveSubject({
            entry,
            attributeMap: { subject: 'objectGUID', email: 'mail', firstName: 'givenName', lastName: 'sn' },
        })).toBeUndefined()
    })
})

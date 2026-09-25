import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolve4 = vi.fn()
const resolve6 = vi.fn()

vi.mock('node:dns/promises', () => ({
    default: {
        resolve4: (...args: unknown[]) => resolve4(...args),
        resolve6: (...args: unknown[]) => resolve6(...args),
    },
}))

const ORIGINAL_LDAP_ALLOW_LIST = process.env['AP_LDAP_ALLOW_LIST']

async function importGuard() {
    const module = await import('../../../../../src/app/authentication/ldap/ldap-host-guard')
    return module.ldapHostGuard
}

describe('ldapHostGuard.resolveVettedIps', () => {
    beforeEach(() => {
        vi.resetModules()
        resolve4.mockReset()
        resolve6.mockReset()
        delete process.env['AP_LDAP_ALLOW_LIST']
    })

    afterEach(() => {
        if (ORIGINAL_LDAP_ALLOW_LIST === undefined) {
            delete process.env['AP_LDAP_ALLOW_LIST']
        }
        else {
            process.env['AP_LDAP_ALLOW_LIST'] = ORIGINAL_LDAP_ALLOW_LIST
        }
    })

    it('rejects a private A record when it is not allow-listed', async () => {
        resolve4.mockResolvedValue(['10.0.0.5'])
        resolve6.mockResolvedValue([])
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.internal.corp' })).rejects.toThrow()
    })

    it('accepts a private A record once it is allow-listed', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '10.0.0.5'
        resolve4.mockResolvedValue(['10.0.0.5'])
        resolve6.mockResolvedValue([])
        const ldapHostGuard = await importGuard()
        const ips = await ldapHostGuard.resolveVettedIps({ host: 'dc.internal.corp' })
        expect(ips).toEqual(['10.0.0.5'])
    })

    it('never allows a cloud metadata address, even when explicitly allow-listed', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '169.254.169.254'
        resolve4.mockResolvedValue(['169.254.169.254'])
        resolve6.mockResolvedValue([])
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'metadata.internal' })).rejects.toThrow()
    })

    it('rejects a multi-homed name when only one of several A records is blocked', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '8.8.8.8'
        resolve4.mockResolvedValue(['8.8.8.8', '10.0.0.9'])
        resolve6.mockResolvedValue([])
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.mixed.corp' })).rejects.toThrow()
    })

    it('rejects an IPv4-mapped IPv6 address representing a private IPv4', async () => {
        resolve4.mockResolvedValue([])
        resolve6.mockResolvedValue(['::ffff:10.0.0.5'])
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.v6.corp' })).rejects.toThrow()
    })

    it('classifies an IP literal directly, with no DNS lookup at all', async () => {
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: '10.0.0.5' })).rejects.toThrow()
        expect(resolve4).not.toHaveBeenCalled()
        expect(resolve6).not.toHaveBeenCalled()
    })

    it('accepts a public A record with no allow-list entry needed', async () => {
        resolve4.mockResolvedValue(['8.8.8.8'])
        resolve6.mockResolvedValue([])
        const ldapHostGuard = await importGuard()
        const ips = await ldapHostGuard.resolveVettedIps({ host: 'dc.public.example.com' })
        expect(ips).toEqual(['8.8.8.8'])
    })
})

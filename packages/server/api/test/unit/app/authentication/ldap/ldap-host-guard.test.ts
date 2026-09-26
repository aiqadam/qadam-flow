import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.fn()

vi.mock('node:dns/promises', () => ({
    default: {
        lookup: (...args: unknown[]) => lookup(...args),
    },
}))

const ORIGINAL_LDAP_ALLOW_LIST = process.env['AP_LDAP_ALLOW_LIST']

async function importGuard() {
    const module = await import('../../../../../src/app/authentication/ldap/ldap-host-guard')
    return module.ldapHostGuard
}

// `dns.lookup(host, { all: true })` resolves to `{ address, family }[]` — every fixture below
// mirrors that exact shape rather than a bare address array, since that is the contract the real
// switch from `resolve4`/`resolve6` to `lookup` (M1/correctness: honouring `/etc/hosts` and Docker
// `extra_hosts`) actually changed.
function addresses(...ips: string[]): Array<{ address: string, family: number }> {
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

describe('ldapHostGuard.resolveVettedIps', () => {
    beforeEach(() => {
        vi.resetModules()
        lookup.mockReset()
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
        lookup.mockResolvedValue(addresses('10.0.0.5'))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.internal.corp' })).rejects.toThrow()
    })

    it('accepts a private A record once it is allow-listed', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '10.0.0.5'
        lookup.mockResolvedValue(addresses('10.0.0.5'))
        const ldapHostGuard = await importGuard()
        const ips = await ldapHostGuard.resolveVettedIps({ host: 'dc.internal.corp' })
        expect(ips).toEqual(['10.0.0.5'])
    })

    it('never allows a cloud metadata address, even when explicitly allow-listed', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '169.254.169.254'
        lookup.mockResolvedValue(addresses('169.254.169.254'))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'metadata.internal' })).rejects.toThrow()
    })

    it.each([
        ['169.254.170.2', 'the AWS ECS task metadata address'],
        ['100.100.100.200', 'the Alibaba Cloud metadata address'],
        ['fd00:ec2::254', 'the AWS IPv6 metadata address'],
    ])('never allows %s (%s), even when explicitly allow-listed', async (metadataIp) => {
        process.env['AP_LDAP_ALLOW_LIST'] = metadataIp
        lookup.mockResolvedValue(addresses(metadataIp))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'metadata.internal' })).rejects.toThrow()
    })

    it('never allows an ::ffff:-mapped cloud metadata address, even when explicitly allow-listed', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '::ffff:169.254.169.254'
        lookup.mockResolvedValue(addresses('::ffff:169.254.169.254'))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'metadata.internal' })).rejects.toThrow()
    })

    it('rejects a multi-homed name when only one of several A records is blocked', async () => {
        process.env['AP_LDAP_ALLOW_LIST'] = '8.8.8.8'
        lookup.mockResolvedValue(addresses('8.8.8.8', '10.0.0.9'))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.mixed.corp' })).rejects.toThrow()
    })

    it('rejects an IPv4-mapped IPv6 address representing a private IPv4', async () => {
        lookup.mockResolvedValue(addresses('::ffff:10.0.0.5'))
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: 'dc.v6.corp' })).rejects.toThrow()
    })

    it('classifies an IP literal directly, with no DNS lookup at all', async () => {
        const ldapHostGuard = await importGuard()
        await expect(ldapHostGuard.resolveVettedIps({ host: '10.0.0.5' })).rejects.toThrow()
        expect(lookup).not.toHaveBeenCalled()
    })

    it('accepts a public A record with no allow-list entry needed', async () => {
        lookup.mockResolvedValue(addresses('8.8.8.8'))
        const ldapHostGuard = await importGuard()
        const ips = await ldapHostGuard.resolveVettedIps({ host: 'dc.public.example.com' })
        expect(ips).toEqual(['8.8.8.8'])
    })

    it('resolves via dns.lookup with { all: true }, so /etc/hosts and extra_hosts are honoured', async () => {
        lookup.mockResolvedValue(addresses('8.8.8.8'))
        const ldapHostGuard = await importGuard()
        await ldapHostGuard.resolveVettedIps({ host: 'dc.public.example.com' })
        expect(lookup).toHaveBeenCalledWith('dc.public.example.com', { all: true })
    })
})

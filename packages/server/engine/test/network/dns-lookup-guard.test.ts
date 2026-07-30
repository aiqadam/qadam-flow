import dns from 'node:dns'
import { SSRFBlockedError } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ssrfGuard } from '../../src/lib/network/ssrf-guard'

const V6_THEN_V4: dns.LookupAddress[] = [
    { address: '2001:4860:4860::8888', family: 6 },
    { address: '8.8.8.8', family: 4 },
]
const V4_ONLY: dns.LookupAddress[] = [
    { address: '8.8.8.8', family: 4 },
]
const PUBLIC_V4_AND_LOOPBACK_V6: dns.LookupAddress[] = [
    { address: '8.8.8.8', family: 4 },
    { address: '::1', family: 6 },
]

type CallbackResult = {
    err: NodeJS.ErrnoException | null
    address: string | dns.LookupAddress[] | undefined
    family: number | undefined
}

function mockPromiseResolver(entries: dns.LookupAddress[]): void {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue(entries as unknown as dns.LookupAddress)
}

function mockCallbackResolver(entries: dns.LookupAddress[]): void {
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: unknown, optionsOrCb: unknown, cb?: unknown) => {
        const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb
        ;(callback as (err: Error | null, addresses: dns.LookupAddress[]) => void)(null, entries)
    }) as unknown as typeof dns.lookup)
}

function callbackLookup(invoke: (done: (result: CallbackResult) => void) => void): Promise<CallbackResult> {
    return new Promise<CallbackResult>((resolve) => invoke(resolve))
}

describe('dns-lookup-guard address family', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        ssrfGuard.uninstall()
        vi.restoreAllMocks()
    })

    describe('promises api', () => {
        it('honours a numeric family argument', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test', 4)
            expect(result).toEqual({ address: '8.8.8.8', family: 4 })
        })

        it('honours a family passed in the options object', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test', { family: 4 })
            expect(result).toEqual({ address: '8.8.8.8', family: 4 })
        })

        it('resolves every family at the resolver even when the caller asked for one', async () => {
            const resolver = vi.spyOn(dns.promises, 'lookup').mockResolvedValue(V6_THEN_V4 as unknown as dns.LookupAddress)
            ssrfGuard.install({ enabled: true, allowList: [] })
            await dns.promises.lookup('mixed.example.test', { family: 4, hints: dns.ADDRCONFIG })
            expect(resolver).toHaveBeenCalledWith('mixed.example.test', { all: true, hints: dns.ADDRCONFIG })
        })

        // The block list is applied to what can actually be returned, not to every family the host
        // has. Checking every family looks stronger and is not: it rejects an address that can
        // never reach the caller, and it breaks AP_SSRF_ALLOW_LIST on a dual-stack host — see the
        // allow-list case below, which is the regression CI caught.
        it('does not block on a family the caller cannot receive', async () => {
            mockPromiseResolver(PUBLIC_V4_AND_LOOPBACK_V6)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test', 4)
            expect(result).toEqual({ address: '8.8.8.8', family: 4 })
        })

        it('still blocks when the blocked record IS in the family the caller asked for', async () => {
            mockPromiseResolver(PUBLIC_V4_AND_LOOPBACK_V6)
            ssrfGuard.install({ enabled: true, allowList: [] })
            await expect(dns.promises.lookup('mixed.example.test', 6)).rejects.toBeInstanceOf(SSRFBlockedError)
        })

        // Verbatim the shape of the ssrf-guard allow-list test that this change first broke: an
        // operator allow-lists an IPv4 literal and asks for family 4, on a host that also has a
        // loopback IPv6. Local DNS resolved `localhost` to v4 only, so it passed here and failed
        // on CI — hence a mocked dual-stack host rather than a real name.
        it('honours an IPv4 allow-list entry on a dual-stack host', async () => {
            mockPromiseResolver([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
            ssrfGuard.install({ enabled: true, allowList: ['127.0.0.1'] })
            const result = await dns.promises.lookup('localhost.example.test', 4)
            expect(result).toEqual({ address: '127.0.0.1', family: 4 })
        })

        it('still returns the full array for an { all: true } caller', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test', { all: true })
            expect(result).toEqual(V6_THEN_V4)
        })

        it('narrows the array for an { all: true } caller that also asked for a family', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test', { all: true, family: 6 })
            expect(result).toEqual([{ address: '2001:4860:4860::8888', family: 6 }])
        })

        it('fails with ENOTFOUND when the family filter leaves nothing', async () => {
            mockPromiseResolver(V4_ONLY)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const error = await dns.promises.lookup('v4only.example.test', 6).then(
                (value) => value,
                (reason: NodeJS.ErrnoException) => reason,
            )
            expect(error).toBeInstanceOf(Error)
            expect((error as NodeJS.ErrnoException).code).toBe('ENOTFOUND')
            expect((error as NodeJS.ErrnoException).syscall).toBe('getaddrinfo')
            expect((error as Error).message).toBe('getaddrinfo ENOTFOUND v4only.example.test')
        })

        it('fails with ENOTFOUND when the family filter leaves nothing for an { all: true } caller', async () => {
            mockPromiseResolver(V4_ONLY)
            ssrfGuard.install({ enabled: true, allowList: [] })
            await expect(dns.promises.lookup('v4only.example.test', { all: true, family: 6 }))
                .rejects.toMatchObject({ code: 'ENOTFOUND' })
        })

        it('returns the first entry unchanged when no family is requested', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await dns.promises.lookup('mixed.example.test')
            expect(result).toEqual({ address: '2001:4860:4860::8888', family: 6 })
        })
    })

    describe('callback api', () => {
        it('honours a numeric family argument', async () => {
            mockCallbackResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', 4, (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toBe('8.8.8.8')
            expect(result.family).toBe(4)
        })

        it('honours a family passed in the options object', async () => {
            mockCallbackResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', { family: 4 }, (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toBe('8.8.8.8')
            expect(result.family).toBe(4)
        })

        it('resolves every family at the resolver even when the caller asked for one', async () => {
            const resolver = vi.spyOn(dns, 'lookup').mockImplementation(((_host: unknown, optionsOrCb: unknown, cb?: unknown) => {
                const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb
                ;(callback as (err: Error | null, addresses: dns.LookupAddress[]) => void)(null, V6_THEN_V4)
            }) as unknown as typeof dns.lookup)
            ssrfGuard.install({ enabled: true, allowList: [] })
            await callbackLookup((done) => {
                dns.lookup('mixed.example.test', { family: 4, hints: dns.ADDRCONFIG }, (err, address, family) => done({ err, address, family }))
            })
            expect(resolver).toHaveBeenCalledWith('mixed.example.test', { all: true, hints: dns.ADDRCONFIG }, expect.any(Function))
        })

        it('does not block on a family the caller cannot receive', async () => {
            mockCallbackResolver(PUBLIC_V4_AND_LOOPBACK_V6)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', 4, (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toBe('8.8.8.8')
        })

        it('still blocks when the blocked record IS in the family the caller asked for', async () => {
            mockCallbackResolver(PUBLIC_V4_AND_LOOPBACK_V6)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', 6, (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeInstanceOf(SSRFBlockedError)
        })

        it('still returns the full array for an { all: true } caller', async () => {
            mockCallbackResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', { all: true }, (err, address) => done({ err, address, family: undefined }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toEqual(V6_THEN_V4)
        })

        it('narrows the array for an { all: true } caller that also asked for a family', async () => {
            mockCallbackResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', { all: true, family: 4 }, (err, address) => done({ err, address, family: undefined }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toEqual([{ address: '8.8.8.8', family: 4 }])
        })

        it('fails with ENOTFOUND when the family filter leaves nothing', async () => {
            mockCallbackResolver(V4_ONLY)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('v4only.example.test', 6, (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeInstanceOf(Error)
            expect(result.err?.code).toBe('ENOTFOUND')
            expect(result.err?.syscall).toBe('getaddrinfo')
            expect(result.err?.message).toBe('getaddrinfo ENOTFOUND v4only.example.test')
        })

        it('returns the first entry unchanged when no family is requested', async () => {
            mockCallbackResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })
            const result = await callbackLookup((done) => {
                dns.lookup('mixed.example.test', (err, address, family) => done({ err, address, family }))
            })
            expect(result.err).toBeNull()
            expect(result.address).toBe('2001:4860:4860::8888')
            expect(result.family).toBe(6)
        })
    })

    // These close the gaps an app-sec review found by mutation: each of the guarantees below was
    // one the implementation claimed and no test could detect losing.
    describe('guarantees the review found unasserted', () => {
        it('does not narrow the resolver for a NUMERIC family either', async () => {
            const resolver = vi.spyOn(dns.promises, 'lookup').mockResolvedValue(V6_THEN_V4 as unknown as dns.LookupAddress)
            ssrfGuard.install({ enabled: true, allowList: [] })

            await dns.promises.lookup('mixed.example.test', 4)

            // The block list has to see every family, so the family must not reach the resolver.
            expect(resolver).toHaveBeenCalledWith('mixed.example.test', { all: true })
        })

        it('cannot have all:true overridden by a caller passing all:false', async () => {
            const resolver = vi.spyOn(dns.promises, 'lookup').mockResolvedValue(V6_THEN_V4 as unknown as dns.LookupAddress)
            ssrfGuard.install({ enabled: true, allowList: [] })

            await dns.promises.lookup('mixed.example.test', { all: false })

            expect(resolver).toHaveBeenCalledWith('mixed.example.test', expect.objectContaining({ all: true }))
        })

        // The host's only record is a blocked IPv6 and the caller asked for IPv4. Nothing is
        // returnable, so the honest answer is the resolver's own ENOTFOUND — reporting a block
        // would claim the guard stopped something it was never going to hand over. Either way no
        // address is returned; this pins which of the two the caller sees.
        it.each([
            ['promises', async () => dns.promises.lookup('blocked.example.test', 4)],
            ['callback', async () => new Promise((_resolve, reject) => {
                dns.lookup('blocked.example.test', 4, (err) => reject(err))
            })],
        ])('reports ENOTFOUND, not a block, when the only record is of another family (%s)', async (_label, run) => {
            mockPromiseResolver([{ address: '::1', family: 6 }])
            mockCallbackResolver([{ address: '::1', family: 6 }])
            ssrfGuard.install({ enabled: true, allowList: [] })

            await expect(run()).rejects.toMatchObject({ code: 'ENOTFOUND' })
        })

        it('treats family 0 as "any" and filters nothing', async () => {
            mockPromiseResolver(V6_THEN_V4)
            ssrfGuard.install({ enabled: true, allowList: [] })

            const result = await dns.promises.lookup('mixed.example.test', { family: 0, all: true })

            expect(result).toEqual(V6_THEN_V4)
        })

        it.each([['IPv4', 4, '8.8.8.8'], ['IPv6', 6, '2001:4860:4860::8888']] as const)(
            'honours the string family spelling %s, which Node documents and used to work',
            async (spelling, expectedFamily, expectedAddress) => {
                mockPromiseResolver(V6_THEN_V4)
                ssrfGuard.install({ enabled: true, allowList: [] })

                const result = await dns.promises.lookup('mixed.example.test', { family: spelling } as unknown as dns.LookupOneOptions)

                expect(result).toEqual({ address: expectedAddress, family: expectedFamily })
            },
        )

        // AI_V4MAPPED is only meaningful with AF_INET6, and this guard deliberately keeps the
        // family away from the resolver — so without explicit handling the hint goes inert and the
        // family filter turns a working lookup into ENOTFOUND.
        it('maps v4 records for a family-6 caller that asked for V4MAPPED, instead of failing', async () => {
            mockPromiseResolver(V4_ONLY)
            ssrfGuard.install({ enabled: true, allowList: [] })

            const result = await dns.promises.lookup('v4only.example.test', { family: 6, hints: dns.V4MAPPED })

            expect(result).toEqual({ address: '::ffff:8.8.8.8', family: 6 })
        })

        it('still blocks a v4 record that V4MAPPED would have surfaced as IPv6', async () => {
            mockPromiseResolver([{ address: '127.0.0.1', family: 4 }])
            ssrfGuard.install({ enabled: true, allowList: [] })

            await expect(dns.promises.lookup('loopback.example.test', { family: 6, hints: dns.V4MAPPED }))
                .rejects.toBeInstanceOf(SSRFBlockedError)
        })
    })
})

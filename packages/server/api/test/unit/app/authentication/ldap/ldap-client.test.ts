import { LdapTlsMode } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file tests `ldap-client.ts`'s own connection-management logic (M1) against a fake
// `ldapts.Client` and a stubbed host guard — not a real socket or directory — since what is under
// test here is our own timeout-racing, IP-capping and slot-accounting code, not `ldapts`'s wire
// protocol (that is `ldap-openldap.test.ts`'s job, against a real directory).
const fakeClientState = vi.hoisted(() => ({
    constructedUrls: [] as string[],
    constructedTlsOptions: [] as (Record<string, unknown> | undefined)[],
    startTlsBehavior: 'resolve' as 'resolve' | 'stall' | 'reject',
    isConnectedValue: true,
    unbindCalls: 0,
    searchCalls: [] as { baseDn: string, options: { filter: string } }[],
    searchEntries: [] as unknown[],
}))

vi.mock('ldapts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ldapts')>()
    class FakeClient {
        constructor(options: { url: string, tlsOptions?: Record<string, unknown> }) {
            fakeClientState.constructedUrls.push(options.url)
            fakeClientState.constructedTlsOptions.push(options.tlsOptions)
        }

        get isConnected(): boolean {
            return fakeClientState.isConnectedValue
        }

        async startTLS(): Promise<void> {
            if (fakeClientState.startTlsBehavior === 'stall') {
                return new Promise<void>(() => undefined)
            }
            if (fakeClientState.startTlsBehavior === 'reject') {
                throw new Error('simulated StartTLS failure')
            }
        }

        async bind(): Promise<void> {
            return undefined
        }

        async unbind(): Promise<void> {
            fakeClientState.unbindCalls += 1
        }

        async search(baseDn: string, options: { filter: string }): Promise<{ searchEntries: unknown[] }> {
            fakeClientState.searchCalls.push({ baseDn, options })
            return { searchEntries: fakeClientState.searchEntries }
        }
    }
    return { ...actual, Client: FakeClient }
})

const resolveVettedIps = vi.fn()
vi.mock('../../../../../src/app/authentication/ldap/ldap-host-guard', () => ({
    ldapHostGuard: { resolveVettedIps: (...args: unknown[]) => resolveVettedIps(...args) },
}))

async function importClient() {
    const module = await import('../../../../../src/app/authentication/ldap/ldap-client')
    return module.ldapClient
}

beforeEach(() => {
    vi.resetModules()
    fakeClientState.constructedUrls = []
    fakeClientState.constructedTlsOptions = []
    fakeClientState.startTlsBehavior = 'resolve'
    fakeClientState.isConnectedValue = true
    fakeClientState.unbindCalls = 0
    fakeClientState.searchCalls = []
    fakeClientState.searchEntries = []
    resolveVettedIps.mockReset()
})

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
})

const starttlsConfig = {
    url: 'ldap://directory.example.com:389',
    tlsMode: LdapTlsMode.STARTTLS,
    tlsVerify: true,
}

describe('ldapClient.connect — StartTLS handshake timeout (M1)', () => {
    it('destroys the socket and rejects when the handshake stalls, rather than hanging forever', async () => {
        vi.useFakeTimers()
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        fakeClientState.startTlsBehavior = 'stall'
        const ldapClient = await importClient()

        const connectPromise = ldapClient.connect({ config: starttlsConfig })
        const assertion = expect(connectPromise).rejects.toThrow(/StartTLS/)
        await vi.advanceTimersByTimeAsync(5000)
        await assertion
        expect(fakeClientState.unbindCalls).toBeGreaterThan(0)
    })

    it('resolves normally when the handshake completes before the timeout', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        fakeClientState.startTlsBehavior = 'resolve'
        const ldapClient = await importClient()

        await expect(ldapClient.connect({ config: starttlsConfig })).resolves.toBeDefined()
    })
})

describe('ldapClient.connect — cap on vetted IPs tried per attempt (M1)', () => {
    it('tries at most 4 vetted IPs before giving up', async () => {
        resolveVettedIps.mockResolvedValue(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6'])
        fakeClientState.startTlsBehavior = 'reject'
        const ldapClient = await importClient()

        await expect(ldapClient.connect({ config: starttlsConfig })).rejects.toThrow()
        expect(fakeClientState.constructedUrls).toHaveLength(4)
    })
})

describe('ldapClient.connect — scheme assertion', () => {
    it('refuses a URL whose scheme does not match tlsMode, before any DNS lookup or dial', async () => {
        const ldapClient = await importClient()

        await expect(ldapClient.connect({
            config: { url: 'ldaps://directory.example.com:636', tlsMode: LdapTlsMode.STARTTLS, tlsVerify: true },
        })).rejects.toThrow()
        expect(resolveVettedIps).not.toHaveBeenCalled()
    })
})

describe('ldapClient.connect — TLS servername vs. IP literal (Node DEP0123)', () => {
    it('sets servername to the configured hostname for a DNS name', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()

        await ldapClient.connect({
            config: { url: 'ldaps://directory.example.com:636', tlsMode: LdapTlsMode.LDAPS, tlsVerify: true },
        })

        expect(fakeClientState.constructedTlsOptions[0]?.servername).toBe('directory.example.com')
    })

    it('omits servername outright when the configured host is an IP literal', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()

        await ldapClient.connect({
            config: { url: 'ldaps://10.0.0.5:636', tlsMode: LdapTlsMode.LDAPS, tlsVerify: true },
        })

        expect(fakeClientState.constructedTlsOptions[0]).not.toHaveProperty('servername')
    })

    it('omits servername for an IPv6 literal host too', async () => {
        resolveVettedIps.mockResolvedValue(['::1'])
        const ldapClient = await importClient()

        await ldapClient.connect({
            config: { url: 'ldaps://[::1]:636', tlsMode: LdapTlsMode.LDAPS, tlsVerify: true },
        })

        expect(fakeClientState.constructedTlsOptions[0]).not.toHaveProperty('servername')
    })
})

describe('ldapClient.serviceBind / searchForUser — plaintext-reconnect guard (StartTLS only)', () => {
    it('refuses to operate once the StartTLS-upgraded connection is no longer connected', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()
        const client = await ldapClient.connect({ config: starttlsConfig })
        fakeClientState.isConnectedValue = false

        await expect(ldapClient.serviceBind({
            client, bindDn: 'cn=svc', bindPassword: 'secret', tlsMode: LdapTlsMode.STARTTLS,
        })).rejects.toThrow(/plaintext|lost/)
    })

    it('does not apply the guard to an LDAPS client (always secure for its whole life)', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()
        const client = await ldapClient.connect({ config: { ...starttlsConfig, url: 'ldaps://directory.example.com:636', tlsMode: LdapTlsMode.LDAPS } })
        fakeClientState.isConnectedValue = false

        await expect(ldapClient.serviceBind({
            client, bindDn: 'cn=svc', bindPassword: 'secret', tlsMode: LdapTlsMode.LDAPS,
        })).resolves.toBeUndefined()
    })

    // `bindAsUser` connects internally rather than taking an already-connected client, but the
    // guard must still apply to it — the doc comment on `assertConnectionStillUpgraded` claims it
    // runs "before serviceBind/searchForUser/the user bind", and this is what makes that true rather
    // than aspirational.
    it('applies the same guard to bindAsUser (the user bind)', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        fakeClientState.isConnectedValue = false
        const ldapClient = await importClient()

        await expect(ldapClient.bindAsUser({
            config: starttlsConfig, userDn: 'uid=jdoe,dc=example,dc=com', password: 'secret',
        })).rejects.toThrow(/plaintext|lost/)
    })
})

describe('ldapClient.withConnectionSlot — concurrency cap, queue cap, wait timeout and off-by-one (M1)', () => {
    function makeHolder(ldapClient: Awaited<ReturnType<typeof importClient>>): { started: Promise<void>, release: () => void, done: Promise<void> } {
        let markStarted: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
            markStarted = resolve 
        })
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve 
        })
        const done = ldapClient.withConnectionSlot(async () => {
            markStarted?.()
            await gate
        })
        if (release === undefined) {
            throw new Error('release was not assigned')
        }
        return { started, release, done }
    }

    it('queues an 11th caller until a held slot is released', async () => {
        const ldapClient = await importClient()
        const holders = Array.from({ length: 10 }, () => makeHolder(ldapClient))
        await Promise.all(holders.map((holder) => holder.started))

        const waiter = makeHolder(ldapClient)
        let waiterStarted = false
        void waiter.started.then(() => {
            waiterStarted = true 
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(waiterStarted).toBe(false)

        holders[0].release()
        await waiter.started
        expect(waiterStarted).toBe(true)

        holders.slice(1).forEach((holder) => holder.release())
        waiter.release()
        await Promise.all([...holders.map((holder) => holder.done), waiter.done])
    })

    it('rejects outright once the waiter queue is already full, rather than queuing without bound', async () => {
        const ldapClient = await importClient()
        const holders = Array.from({ length: 10 }, () => makeHolder(ldapClient))
        await Promise.all(holders.map((holder) => holder.started))

        const waiters = Array.from({ length: 50 }, () => makeHolder(ldapClient))
        // Let the 50 waiters actually register themselves in the queue before testing the 51st.
        await Promise.resolve()
        await Promise.resolve()

        await expect(ldapClient.withConnectionSlot(async () => undefined)).rejects.toThrow(/[Tt]oo many/)

        holders.forEach((holder) => holder.release())
        waiters.forEach((holder) => holder.release())
        await Promise.all([...holders.map((holder) => holder.done), ...waiters.map((holder) => holder.done)])
    })

    it('times out a waiter that never gets a free slot', async () => {
        vi.useFakeTimers()
        const ldapClient = await importClient()
        const holders = Array.from({ length: 10 }, () => makeHolder(ldapClient))
        await Promise.all(holders.map((holder) => holder.started))

        const waiterResult = ldapClient.withConnectionSlot(async () => undefined)
        const assertion = expect(waiterResult).rejects.toThrow(/[Tt]imed out/)
        await vi.advanceTimersByTimeAsync(5000)
        await assertion

        holders.forEach((holder) => holder.release())
        await Promise.all(holders.map((holder) => holder.done))
    })

    // The bug this guards against: the previous shape decremented the active-connection count
    // *and then* woke a waiter, which itself incremented the count again once its own promise
    // continuation ran — leaving a window, between those two steps, where a brand-new acquirer
    // could see a spuriously-free slot and take it via the fast path, on top of the woken waiter
    // also about to claim it. This drives heavy overlapping acquire/release churn and checks the
    // invariant the whole mechanism exists to guarantee: peak concurrency never exceeds the cap.
    it('never lets peak concurrent holders exceed the cap under heavy overlapping churn', async () => {
        const ldapClient = await importClient()
        let concurrent = 0
        let peak = 0
        const runOne = (): Promise<void> => ldapClient.withConnectionSlot(async () => {
            concurrent += 1
            peak = Math.max(peak, concurrent)
            await Promise.resolve()
            concurrent -= 1
        })
        // A fixed pool of 15 workers (more than the cap of 10) each firing its *next* acquire the
        // instant its previous one releases, for many iterations, all running concurrently — this
        // keeps fresh acquires and in-flight releases continuously overlapping in time, rather
        // than issuing every acquire for a round up front (which never actually interleaves a
        // release with a brand-new acquire, and so cannot exercise the handoff race this guards
        // against at all).
        const worker = async (): Promise<void> => {
            for (let i = 0; i < 30; i++) {
                await runOne()
            }
        }
        await Promise.all(Array.from({ length: 15 }, worker))
        expect(peak).toBeLessThanOrEqual(10)
    })

    function makeTrackedHolder({ ldapClient, tracker }: MakeTrackedHolderParams): { started: Promise<void>, release: () => void, done: Promise<void> } {
        let markStarted: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
            markStarted = resolve
        })
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const done = ldapClient.withConnectionSlot(async () => {
            tracker.concurrent += 1
            tracker.peak = Math.max(tracker.peak, tracker.concurrent)
            markStarted?.()
            await gate
            tracker.concurrent -= 1
        })
        if (release === undefined) {
            throw new Error('release was not assigned')
        }
        return { started, release, done }
    }

    // Direct reproduction of the historical off-by-one, swept across the exact variable the race
    // depends on: how many microtask ticks separate `releaseConnectionSlot` handing the freed slot
    // to the queued waiter from a brand-new, unrelated acquirer's own synchronous cap check. Against
    // the *previous* (decrement-then-later-increment) shape, this goes red at some depth in the
    // sweep — the decrement is visible to the intruder's synchronous check before the woken waiter's
    // own `await`-resumed continuation re-increments, so both the waiter and the intruder end up
    // holding a slot for what was really one freed slot, one over the cap. Verified by hand: with
    // `releaseConnectionSlot` reverted to `activeConnections -= 1; const next =
    // connectionWaiters.shift(); if (!isNil(next)) next()` and `acquireConnectionSlot`'s waiter path
    // reverted to `await new Promise(...); activeConnections += 1`, this sweep failed at depth 2
    // (`expected 11 to be less than or equal to 10`) — confirming this is a real reproduction, not
    // merely an invariant check that happens to stay green regardless of the fix. Exactly which
    // depth goes red is a property of the JS engine's own microtask scheduling, not guaranteed
    // across Node versions, which is the whole reason this sweeps a range rather than asserting one
    // fixed depth. Against the fix, the slot is handed over atomically with no decrement step at
    // all, so no depth in the sweep can expose a transiently-free slot.
    it.each([0, 1, 2, 3, 4, 5, 6, 7])('never lets a queued waiter and a same-window intruder both hold the one freed slot (intruder fires %i microtask tick(s) after the release)', async (depth) => {
        const ldapClient = await importClient()
        const tracker = { concurrent: 0, peak: 0 }

        const holders = Array.from({ length: 10 }, () => makeTrackedHolder({ ldapClient, tracker }))
        await Promise.all(holders.map((holder) => holder.started))

        const waiter = makeTrackedHolder({ ldapClient, tracker })
        await Promise.resolve()
        await Promise.resolve()

        holders[0].release()
        for (let i = 0; i < depth; i++) {
            await Promise.resolve()
        }
        const intruder = makeTrackedHolder({ ldapClient, tracker })

        // Drain enough microtask ticks for anything the intruder's own acquire is going to do —
        // synchronously take the fast path, or queue behind the waiter — to have already happened.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        expect(tracker.peak).toBeLessThanOrEqual(10)

        holders.slice(1).forEach((holder) => holder.release())
        waiter.release()
        intruder.release()
        await Promise.all([...holders.map((holder) => holder.done), waiter.done, intruder.done])
    })
})

describe('ldapClient.searchBySubject — objectGUID round trip and malformed-subject guard (round 2)', () => {
    const objectGuidAttributeMap = { subject: 'objectGUID' as const, email: 'mail', firstName: 'givenName', lastName: 'sn' }

    it('converts a known canonical objectGUID string to the RFC 4515 octet-escaped filter value', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()
        const client = await ldapClient.connect({ config: { url: 'ldaps://directory.example.com:636', tlsMode: LdapTlsMode.LDAPS, tlsVerify: true } })

        // Same known vector as ldap-attributes.test.ts's forward-direction test: raw bytes
        // `78563412341278569abcdef012345678` canonicalize to this string; the filter value must be
        // exactly those same raw bytes, RFC 4515 §3 octet-escaped (`\XX` per byte) — the inverse of
        // that conversion, not a re-derivation from the string's own displayed byte order.
        await ldapClient.searchBySubject({
            client,
            baseDn: 'dc=example,dc=com',
            attributeMap: objectGuidAttributeMap,
            subject: '12345678-1234-5678-9abc-def012345678',
            tlsMode: LdapTlsMode.LDAPS,
        })

        expect(fakeClientState.searchCalls).toHaveLength(1)
        expect(fakeClientState.searchCalls[0].options.filter).toBe('(objectGUID=\\78\\56\\34\\12\\34\\12\\78\\56\\9a\\bc\\de\\f0\\12\\34\\56\\78)')
    })

    it('refuses a malformed stored subject rather than building a filter from it', async () => {
        resolveVettedIps.mockResolvedValue(['10.0.0.5'])
        const ldapClient = await importClient()
        const client = await ldapClient.connect({ config: { url: 'ldaps://directory.example.com:636', tlsMode: LdapTlsMode.LDAPS, tlsVerify: true } })

        await expect(ldapClient.searchBySubject({
            client,
            baseDn: 'dc=example,dc=com',
            attributeMap: objectGuidAttributeMap,
            subject: 'not-a-canonical-guid',
            tlsMode: LdapTlsMode.LDAPS,
        })).rejects.toThrow(/canonical objectGUID/)
        expect(fakeClientState.searchCalls).toHaveLength(0)
    })
})

type MakeTrackedHolderParams = {
    ldapClient: Awaited<ReturnType<typeof importClient>>
    tracker: { concurrent: number, peak: number }
}

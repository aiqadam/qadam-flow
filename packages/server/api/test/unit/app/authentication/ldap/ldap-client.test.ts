import { LdapTlsMode } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file tests `ldap-client.ts`'s own connection-management logic (M1) against a fake
// `ldapts.Client` and a stubbed host guard — not a real socket or directory — since what is under
// test here is our own timeout-racing, IP-capping and slot-accounting code, not `ldapts`'s wire
// protocol (that is `ldap-openldap.test.ts`'s job, against a real directory).
const fakeClientState = vi.hoisted(() => ({
    constructedUrls: [] as string[],
    startTlsBehavior: 'resolve' as 'resolve' | 'stall' | 'reject',
    isConnectedValue: true,
    unbindCalls: 0,
}))

vi.mock('ldapts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ldapts')>()
    class FakeClient {
        constructor(options: { url: string }) {
            fakeClientState.constructedUrls.push(options.url)
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
    fakeClientState.startTlsBehavior = 'resolve'
    fakeClientState.isConnectedValue = true
    fakeClientState.unbindCalls = 0
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
    // Caveat, stated rather than silently assumed: Node's microtask queue drains in strict FIFO
    // order, and every attempt to force the specific two-releases-then-an-intruder interleaving
    // the bug needs — including a hand-rolled version issuing two synchronous `resolve()` calls
    // back to back followed immediately by a fresh acquire — still resolved every waiter through
    // the FIFO queue in order rather than reproducing the race, both with this fix and with it
    // reverted to the original decrement-then-increment shape. This test does not, in other
    // words, independently prove the historical bug via a failing-without-the-fix run; the fix
    // itself is still correct by inspection (an atomic handoff cannot expose a transiently-free
    // slot; a decrement-then-later-increment pair can), and this test is kept as a real invariant
    // check on the cap under load, not as a claimed reproduction of the specific race.
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
})

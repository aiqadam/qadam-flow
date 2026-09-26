import { LdapTlsMode } from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Round 3: the "real slot" claim in 91831151 was false. That commit's own
// `ldap-config-test-endpoint.test.ts` mocks the whole `ldapClient` module, including
// `withConnectionSlot: (fn) => fn()` — a bare passthrough identical to every other mocked LDAP
// integration test, and just as unable to observe a nested-slot bug. This file instead fakes only
// `ldapts`'s own `Client` (the wire protocol), leaving the real `ldapClient.connect`/`serviceBind`/
// `searchForUser`/`bindAsUser` and, critically, the real `withConnectionSlot` slot-accounting in
// place, and calls the real `ldapConfigService.test()` directly — `repoFactory`/`encryptUtils` are
// faked out so this needs no database.
const trackedState = vi.hoisted(() => ({ concurrent: 0, peak: 0 }))

vi.mock('ldapts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ldapts')>()
    class FakeClient {
        constructor() {
            trackedState.concurrent += 1
            trackedState.peak = Math.max(trackedState.peak, trackedState.concurrent)
        }

        get isConnected(): boolean {
            return true
        }

        async bind(): Promise<void> {
            return undefined
        }

        async search(): Promise<{ searchEntries: Record<string, string>[] }> {
            return {
                searchEntries: [{
                    dn: 'uid=fry,dc=example,dc=com',
                    entryUUID: '11111111-1111-1111-1111-111111111111',
                    mail: 'fry@example.com',
                }],
            }
        }

        async unbind(): Promise<void> {
            trackedState.concurrent -= 1
        }
    }
    return { ...actual, Client: FakeClient }
})

vi.mock('../../../../../src/app/authentication/ldap/ldap-host-guard', () => ({
    ldapHostGuard: { resolveVettedIps: async () => ['10.0.0.5'] },
}))

const fakeRow = {
    id: 'row-1',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    platformId: 'platform-1',
    bindPassword: 'super-secret-bind-password',
    caCertificate: null,
    config: {
        url: 'ldaps://ldap.example.com:636',
        tlsMode: LdapTlsMode.LDAPS,
        baseDn: 'dc=example,dc=com',
        bindDn: 'cn=service,dc=example,dc=com',
        userFilter: '(uid={username})',
        attributeMap: { subject: 'entryUUID', email: 'mail', firstName: 'givenName', lastName: 'sn' },
        tlsVerify: true,
        jitProvisioning: true,
        linkExistingByEmail: false,
        sessionTtlSeconds: 43200,
        enabled: true,
    },
}

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        findOneBy: async () => fakeRow,
    }),
}))

vi.mock('../../../../../src/app/helper/encryption', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/app/helper/encryption')>()
    return {
        ...actual,
        encryptUtils: {
            encryptString: async (value: string) => value,
            decryptString: async (value: string) => value,
        },
    }
})

const log = pino({ level: 'silent' })

beforeEach(() => {
    vi.clearAllMocks()
    trackedState.concurrent = 0
    trackedState.peak = 0
})

describe('ldapConfigService.test — real withConnectionSlot, nested-slot regression (M1 follow-up, round 3)', () => {
    it('never holds more than one connection open at a time for a service-bind + user-bind /test call', async () => {
        const { ldapConfigService } = await import('../../../../../src/app/authentication/ldap/ldap-config-service')

        const response = await ldapConfigService(log).test({
            platformId: 'platform-1',
            request: { username: 'fry', password: 'correct-horse-battery-staple' },
        })

        expect(response.success).toBe(true)
        // The service-bind(+search) connection and the user-bind connection are each a real,
        // separate `Client`. The nested shape held the first connection's slot (and socket) open
        // for the whole call, so a second `Client` opened before the first ever unbound — this
        // would read `peak === 2` against that shape.
        expect(trackedState.peak).toBe(1)
    })
})

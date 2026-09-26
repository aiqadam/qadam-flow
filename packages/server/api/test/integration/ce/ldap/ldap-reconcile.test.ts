import { apId, FederatedIdentityProvider, PlatformRole, PlatformRoleManagedBy, UserIdentityProvider, UserStatus } from '@aiqadam/shared'
import pino from 'pino'
import { userFederatedIdentityService } from '../../../../src/app/authentication/federated-identity/user-federated-identity-service'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { userService } from '../../../../src/app/user/user-service'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Everything except the LDAP wire protocol runs for real, the same split `ldap-sign-in.test.ts`
// uses: real Postgres, real Redis (`distributedLock`), real `ldapReconcileService` orchestration —
// only `ldapClient`'s connect/bind/search primitives are test doubles.
const connect = vi.fn()
const serviceBind = vi.fn()
const searchBySubject = vi.fn()
const resolveMemberGroupDns = vi.fn()

vi.mock('../../../../src/app/authentication/ldap/ldap-client', () => ({
    ldapClient: {
        connect: (...args: unknown[]) => connect(...args),
        serviceBind: (...args: unknown[]) => serviceBind(...args),
        searchBySubject: (...args: unknown[]) => searchBySubject(...args),
        resolveMemberGroupDns: (...args: unknown[]) => resolveMemberGroupDns(...args),
        withConnectionSlot: (fn: () => unknown) => fn(),
    },
}))

const log = pino({ level: 'silent' })

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
    connect.mockReset().mockResolvedValue({ unbind: vi.fn().mockResolvedValue(undefined) })
    serviceBind.mockReset().mockResolvedValue(undefined)
    searchBySubject.mockReset()
    resolveMemberGroupDns.mockReset().mockResolvedValue([])
})

afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
})

async function saveEnabledLdapConfig(platformId: string, configOverrides: Record<string, unknown> = {}): Promise<void> {
    const bindPassword = await encryptUtils.encryptString('bind-secret')
    await databaseConnection().getRepository('platform_ldap_config').save({
        id: apId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        platformId,
        bindPassword,
        caCertificate: null,
        config: {
            url: 'ldaps://ldap.example.com:636',
            tlsMode: 'ldaps',
            baseDn: 'dc=example,dc=com',
            bindDn: 'cn=service,dc=example,dc=com',
            userFilter: '(uid={username})',
            attributeMap: { subject: 'entryUUID', email: 'mail', firstName: 'givenName', lastName: 'sn' },
            tlsVerify: true,
            jitProvisioning: true,
            linkExistingByEmail: false,
            sessionTtlSeconds: 43200,
            enabled: true,
            nestedGroups: false,
            groupMappings: [],
            ...configOverrides,
        },
    })
}

// The `config` column is a plain `json` (not `jsonb`), so an in-place `jsonb_set` update is not an
// option — read the existing row's config back out, merge the override on top in JS, and re-save
// the whole object, the same shape a real config update would write.
async function updateLdapConfig(platformId: string, configOverrides: Record<string, unknown>): Promise<void> {
    const existing = await databaseConnection().getRepository('platform_ldap_config').findOneByOrFail({ platformId })
    await databaseConnection().getRepository('platform_ldap_config').update({ platformId }, {
        config: { ...existing.config, ...configOverrides },
    })
}

async function createLinkedUser({ platformId, subject }: { platformId: string, subject: string }): Promise<{ userId: string, federatedId: string, subject: string }> {
    const identity = await userIdentityService(log).create({
        email: `directory-user-${apId()}@example.com`,
        firstName: 'Directory',
        lastName: 'User',
        password: apId(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId })
    const federated = await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject })
    return { userId: user.id, federatedId: federated.id, subject }
}

async function reconcile(): Promise<void> {
    const { ldapReconcileService } = await import('../../../../src/app/authentication/ldap/ldap-reconcile-service')
    await ldapReconcileService(log).reconcileAllPlatforms()
}

describe('ldapReconcileService.reconcileAllPlatforms — deactivation', () => {
    it('deactivates a user whose directory entry is gone, and records that reconcile did it', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId, federatedId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '11111111-1111-1111-1111-111111111111' })
        searchBySubject.mockResolvedValue(null)

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.INACTIVE)
        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId })
        expect(federated?.directoryDisabledAt).not.toBeNull()
    })

    it('deactivates a user whose directory entry has userAccountControl bit 2 (disabled) set', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '22222222-2222-2222-2222-222222222222' })
        searchBySubject.mockResolvedValue({ dn: 'cn=disabled,dc=example,dc=com', userAccountControl: '514' })

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.INACTIVE)
    })

    it('leaves a present and enabled user untouched (still active)', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '33333333-3333-3333-3333-333333333333' })
        searchBySubject.mockResolvedValue({ dn: 'cn=active,dc=example,dc=com', mail: 'active@example.com' })

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.ACTIVE)
    })
})

describe('ldapReconcileService.reconcileAllPlatforms — reactivation', () => {
    it('reactivates only a user reconcile itself deactivated (directoryDisabledAt set)', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId, federatedId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '44444444-4444-4444-4444-444444444444' })
        searchBySubject.mockResolvedValue(null)
        await reconcile()
        expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.INACTIVE)

        searchBySubject.mockResolvedValue({ dn: 'cn=back,dc=example,dc=com', mail: 'active@example.com' })
        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.ACTIVE)
        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId })
        expect(federated?.directoryDisabledAt).toBeNull()
    })

    it('never reactivates a user an admin deactivated by hand (no directoryDisabledAt marker)', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '55555555-5555-5555-5555-555555555555' })
        await userService(log).update({ id: userId, platformId: mockPlatform.id, status: UserStatus.INACTIVE })
        searchBySubject.mockResolvedValue({ dn: 'cn=back,dc=example,dc=com', mail: 'active@example.com' })

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.INACTIVE)
    })
})

describe('ldapReconcileService.reconcileAllPlatforms — fail-open on outage', () => {
    it('deactivates nobody when the directory connection/bind fails', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '66666666-6666-6666-6666-666666666666' })
        serviceBind.mockRejectedValue(new Error('simulated bind failure'))

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.ACTIVE)
    })

    it('fails closed per account: a search error for one user does not deactivate them', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '77777777-7777-7777-7777-777777777777' })
        searchBySubject.mockRejectedValue(new Error('simulated search timeout'))

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.ACTIVE)
    })
})

describe('ldapReconcileService.reconcileAllPlatforms — safety valve', () => {
    it('aborts the whole run (deactivating nobody) when it would deactivate too large a share of users', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const userIds = await Promise.all(
            Array.from({ length: 5 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `88888888-8888-8888-8888-88888888888${i}` })),
        )
        // Every one of these 5 linked users appears gone — well over the default 20% safety-valve
        // share — which is exactly the failure a wrong baseDn produces.
        searchBySubject.mockResolvedValue(null)

        await reconcile()

        for (const { userId } of userIds) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.status).toBe(UserStatus.ACTIVE)
        }
    })

    // Round 2 (app-sec finding #2): the denominator (and the numerator) must count only real
    // transitions — a user already INACTIVE (25 of the 100 seeded here, permanently reported
    // "gone" by the mocked directory every run, as a stale account genuinely would be) must never
    // inflate either side of the valve's math. 100 linked users total: 25 already INACTIVE and
    // reported gone, 74 ACTIVE and present, 1 ACTIVE and newly gone (the actual new departure).
    // The buggy valve (numerator = every gone/disabled result including the 25 stale ones,
    // denominator = every linked user) computes 26 > ceil(100 * 20 / 100) = 20 and trips, leaving
    // the one real departure undeactivated. The fixed valve counts only the one real transition
    // against the 75 currently-ACTIVE linked users (ceil(75 * 20 / 100) = 15), does not trip, and
    // deactivates the one real departure.
    it('counts only real transitions against currently-ACTIVE linked users, not every already-inactive one', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)

        const alreadyInactive = await Promise.all(
            Array.from({ length: 25 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}` })),
        )
        for (const { userId } of alreadyInactive) {
            await userService(log).update({ id: userId, platformId: mockPlatform.id, status: UserStatus.INACTIVE })
        }
        const activePresent = await Promise.all(
            Array.from({ length: 74 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, '0')}` })),
        )
        const newDeparture = await createLinkedUser({ platformId: mockPlatform.id, subject: 'cccccccc-0000-0000-0000-000000000000' })

        const stillGoneSubjects = new Set(alreadyInactive.map((u) => u.subject).concat(newDeparture.subject))
        searchBySubject.mockImplementation(({ subject }: { subject: string }) => {
            if (stillGoneSubjects.has(subject)) {
                return Promise.resolve(null)
            }
            return Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` })
        })

        await reconcile()

        const newDepartureUser = await userService(log).getOrThrow({ id: newDeparture.userId })
        expect(newDepartureUser.status).toBe(UserStatus.INACTIVE)
        for (const { userId } of activePresent) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.status).toBe(UserStatus.ACTIVE)
        }
    })
})

describe('ldapReconcileService.reconcileAllPlatforms — group mapping re-application', () => {
    it('re-applies the group mapping for a present user on every reconcile pass', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: 'dddddddd-0000-0000-0000-000000000000' })
        await updateLdapConfig(mockPlatform.id, {
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: 'ADMIN', projects: [] }],
        })
        searchBySubject.mockResolvedValue({ dn: 'cn=jdoe,dc=example,dc=com', mail: 'jdoe@example.com' })
        resolveMemberGroupDns.mockResolvedValue(['cn=admins,dc=example,dc=com'])

        await reconcile()

        const promoted = await userService(log).getOrThrow({ id: userId })
        expect(promoted.platformRole).toBe('ADMIN')

        // The user is no longer reported as a member of the admin group on the next pass.
        resolveMemberGroupDns.mockResolvedValue([])
        await reconcile()

        const reverted = await userService(log).getOrThrow({ id: userId })
        expect(reverted.platformRole).toBe('MEMBER')
    })

    it('skips re-applying the group mapping only for the one user whose group search failed, and still processes every other present user', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        await updateLdapConfig(mockPlatform.id, {
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: 'ADMIN', projects: [] }],
        })
        const broken = await createLinkedUser({ platformId: mockPlatform.id, subject: 'eeeeeeee-0000-0000-0000-000000000000' })
        const healthy = await createLinkedUser({ platformId: mockPlatform.id, subject: 'ffffffff-0000-0000-0000-000000000000' })
        searchBySubject.mockImplementation(({ subject }: { subject: string }) =>
            Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` }))
        resolveMemberGroupDns.mockImplementation(({ entry }: { entry: { dn: string } }) => {
            if (entry.dn.includes(broken.subject)) {
                return Promise.reject(new Error('simulated nested-group search failure for this user only'))
            }
            return Promise.resolve(['cn=admins,dc=example,dc=com'])
        })

        await reconcile()

        const brokenUser = await userService(log).getOrThrow({ id: broken.userId })
        expect(brokenUser.platformRole).toBe('MEMBER')
        expect(brokenUser.status).toBe(UserStatus.ACTIVE)
        const healthyUser = await userService(log).getOrThrow({ id: healthy.userId })
        expect(healthyUser.platformRole).toBe('ADMIN')
    })
})

describe('ldapReconcileService.reconcileAllPlatforms — disabled configs', () => {
    it('skips a platform entirely when its LDAP config is disabled', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        await updateLdapConfig(mockPlatform.id, { enabled: false })
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: '99999999-9999-9999-9999-999999999999' })
        searchBySubject.mockResolvedValue(null)

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.ACTIVE)
        expect(searchBySubject).not.toHaveBeenCalled()
    })
})

// Round 3 (app-sec, missing-test finding #8): direct coverage of the two `userService.update` side
// effects the reconcile design depends on, exercised through the real admin path (`source: 'ADMIN'`,
// the controller's own default) rather than only inferred from reconcile's own end-to-end behavior.
describe('userService.update — admin-path provenance side effects', () => {
    it('an admin status write clears directoryDisabledAt on the user\'s federated rows', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId, federatedId } = await createLinkedUser({ platformId: mockPlatform.id, subject: 'a0a0a0a0-0000-0000-0000-000000000000' })
        searchBySubject.mockResolvedValue(null)
        await reconcile()
        expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.INACTIVE)
        expect((await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId }))?.directoryDisabledAt).not.toBeNull()

        await userService(log).update({ id: userId, platformId: mockPlatform.id, status: UserStatus.ACTIVE })

        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId })
        expect(federated?.directoryDisabledAt).toBeNull()
    })

    it('an admin role write resets provenance to MANUAL, even for a role reconcile itself granted', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const { userId } = await createLinkedUser({ platformId: mockPlatform.id, subject: 'b0b0b0b0-0000-0000-0000-000000000000' })
        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.ADMIN, source: 'LDAP' })
        expect((await userService(log).getOrThrow({ id: userId })).platformRoleManagedBy).toBe(PlatformRoleManagedBy.LDAP)

        await userService(log).update({ id: userId, platformId: mockPlatform.id, platformRole: PlatformRole.ADMIN })

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.platformRole).toBe(PlatformRole.ADMIN)
        expect(user.platformRoleManagedBy).toBe(PlatformRoleManagedBy.MANUAL)
    })
})

// Round 3 (app-sec finding #5, must-fix): the per-platform time budget used to slice into
// `linkedIdentities` in whatever order `listByPlatformAndProvider` happened to return them, with no
// rotation — a slow/huge directory would starve the exact same prefix of users every single tick,
// forever. `searchBySubject` carries a small artificial delay here so a small
// `LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS` reliably only covers a strict subset of the linked users
// each run.
describe('ldapReconcileService.reconcileAllPlatforms — time budget rotates across runs', () => {
    it('processes a different subset of users on a second run than the first, under a tiny budget', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        await Promise.all(Array.from({ length: 4 }, (_, i) =>
            createLinkedUser({ platformId: mockPlatform.id, subject: `c0c0c0c${i}-0000-0000-0000-000000000000` })))

        const originalGetNumber = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) {
                return 40
            }
            return originalGetNumber(prop)
        })
        searchBySubject.mockImplementation(({ subject }: { subject: string }) => new Promise((resolve) => {
            setTimeout(() => resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` }), 25)
        }))

        await reconcile()
        const firstRunSubjects = searchBySubject.mock.calls.map((call) => (call[0] as { subject: string }).subject)
        expect(firstRunSubjects.length).toBeGreaterThan(0)
        expect(firstRunSubjects.length).toBeLessThan(4)

        searchBySubject.mockClear()
        await reconcile()
        const secondRunSubjects = searchBySubject.mock.calls.map((call) => (call[0] as { subject: string }).subject)
        expect(secondRunSubjects.length).toBeGreaterThan(0)

        const overlap = secondRunSubjects.filter((subject) => firstRunSubjects.includes(subject))
        expect(overlap).toEqual([])
    })
})

// Round 3 (app-sec finding #6, blocking): the identity snapshot the write-back phase acts on is
// taken at the start of the tick — an admin re-deactivating (or reactivating) the same user can
// land in between that snapshot and this phase actually running. `searchBySubject`'s own mock
// implementation performs the competing admin write as a side effect, simulating it landing at
// the one point in the tick that matters: after reconcile's own snapshot read, before its
// write-back phase.
describe('ldapReconcileService.reconcileAllPlatforms — reactivation race with a concurrent admin write', () => {
    it('never reactivates a user an admin re-deactivated in the moment between the snapshot and the write-back phase', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const { userId, federatedId } = await createLinkedUser({ platformId: mockPlatform.id, subject: 'd0d0d0d0-0000-0000-0000-000000000000' })
        searchBySubject.mockResolvedValue(null)
        await reconcile()
        expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.INACTIVE)
        expect((await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId }))?.directoryDisabledAt).not.toBeNull()

        searchBySubject.mockImplementation(async ({ subject }: { subject: string }) => {
            // The race: an admin deactivates (again) this exact user mid-tick, which clears the
            // marker reconcile's write-back phase is about to act on — landing after reconcile's
            // own snapshot read (`listByPlatformAndProvider`, already done by the time this search
            // call runs) but before that write-back phase runs.
            await userService(log).update({ id: userId, platformId: mockPlatform.id, status: UserStatus.INACTIVE })
            return { dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` }
        })

        await reconcile()

        const user = await userService(log).getOrThrow({ id: userId })
        expect(user.status).toBe(UserStatus.INACTIVE)
        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({ id: federatedId })
        expect(federated?.directoryDisabledAt).toBeNull()
    })
})

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

// Everything about `userFederatedIdentityService` runs for real *except*
// `clearDirectoryDisabledAtIfSet`, which fails on demand for one specific federated-identity id —
// simulating a per-user DB error during reactivation without faking the whole service, so a real
// transaction still runs (and rolls back) for every other identity in the same tick.
const { clearDirectoryDisabledAtIfSetFailuresById } = vi.hoisted(() => ({ clearDirectoryDisabledAtIfSetFailuresById: new Set<string>() }))

vi.mock('../../../../src/app/authentication/federated-identity/user-federated-identity-service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/authentication/federated-identity/user-federated-identity-service')>()
    return {
        ...actual,
        userFederatedIdentityService: (...args: Parameters<typeof actual.userFederatedIdentityService>) => {
            const real = actual.userFederatedIdentityService(...args)
            return {
                ...real,
                clearDirectoryDisabledAtIfSet: (params: Parameters<typeof real.clearDirectoryDisabledAtIfSet>[0]) => {
                    if (clearDirectoryDisabledAtIfSetFailuresById.has(params.id)) {
                        return Promise.reject(new Error('simulated DB error during reactivation'))
                    }
                    return real.clearDirectoryDisabledAtIfSet(params)
                },
            }
        },
    }
})

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
    clearDirectoryDisabledAtIfSetFailuresById.clear()
})

afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.useRealTimers()
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

    // `deactivateUser` moved off `userService.update` (which used to carry an owner
    // guard for every caller) onto the generic `transitionStatusIfCurrentlyEquals`, which has no
    // owner awareness of its own — silently dropping this defense-in-depth layer for reconcile's
    // deactivation path specifically. The owner can never acquire a federated LDAP identity through
    // the normal sign-in path (`assertIdentityIsNotPrivilegedElsewhere` in `ldap-authn-service.ts`
    // refuses it outright), so the row here is inserted directly to exercise reconcile's own guard
    // in isolation, independent of that primary one.
    it('never deactivates the platform owner, even if a federated row somehow points at them', async () => {
        const { mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        await userFederatedIdentityService(log).create({
            platformId: mockPlatform.id,
            userId: mockOwner.id,
            provider: FederatedIdentityProvider.LDAP,
            subject: 'owner-subject-0000-0000-000000000000',
        })
        searchBySubject.mockResolvedValue(null)

        await reconcile()

        const owner = await userService(log).getOrThrow({ id: mockOwner.id })
        expect(owner.status).toBe(UserStatus.ACTIVE)
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

    // A DB error reactivating one specific user (not a directory error) used to
    // propagate out of the per-identity loop with no per-user catch, which the outer `tryCatch`
    // around the whole budget-bounded loop then mistook for a directory outage — aborting every
    // other identity in the same tick too (nobody reactivated, nobody stamped, not even users
    // already finished earlier in the same tick) rather than being this one user's own problem.
    it('a DB error reactivating one user does not abort the rest of the platform\'s tick, and every identity still gets stamped', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        // The safety valve is irrelevant to what this test is about; a tiny linked population
        // where every one of them is a genuine departure would otherwise trip it (a different,
        // already-covered scenario), leaving nobody deactivated in the setup step below.
        const originalGetNumber = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.LDAP_RECONCILE_SAFETY_VALVE_PERCENT) {
                return 100
            }
            return originalGetNumber(prop)
        })
        searchBySubject.mockResolvedValue(null)
        const linked = await Promise.all(Array.from({ length: 3 }, (_, i) =>
            createLinkedUser({ platformId: mockPlatform.id, subject: `ff00000${i}-0000-0000-0000-000000000000` })))
        await reconcile()
        for (const { userId } of linked) {
            expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.INACTIVE)
        }

        clearDirectoryDisabledAtIfSetFailuresById.add(linked[0].federatedId)
        searchBySubject.mockImplementation(({ subject }: { subject: string }) =>
            Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` }))

        await reconcile()

        const brokenUser = await userService(log).getOrThrow({ id: linked[0].userId })
        expect(brokenUser.status).toBe(UserStatus.INACTIVE)
        for (const { userId } of linked.slice(1)) {
            expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.ACTIVE)
        }

        const federatedRepo = databaseConnection().getRepository('user_federated_identity')
        for (const { federatedId } of linked) {
            const row = await federatedRepo.findOneByOrFail({ id: federatedId })
            expect(row.lastReconciledAt).not.toBeNull()
        }
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

    // The denominator (and the numerator) must count only real transitions — a user already
    // INACTIVE (25 of the 100 seeded here, permanently reported "gone" by the mocked directory
    // every run, as a stale account genuinely would be) must never inflate either side of the
    // valve's math. 100 linked users total: 25 already INACTIVE and reported gone, 74 ACTIVE and
    // present, 1 ACTIVE and newly gone (the actual new departure). Counting every gone/disabled
    // result including the 25 stale ones against every linked user would compute 26 against a cap
    // of ceil(100 * 20 / 100) = 20 and trip, leaving the one real departure undeactivated. Counting
    // only the one real transition against the 75 currently-ACTIVE linked users (ceil(75 * 20 /
    // 100) = 15) does not trip, and deactivates the one real departure.
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

    // The slice denominator must be the ACTIVE count among *every* identity this
    // tick processed (present, gone and disabled), not only the ones already headed for
    // deactivation — using the deactivation candidates as their own denominator makes numerator and
    // denominator the same set, so the ratio is always ~100% and the valve trips on any tick with
    // more than a percent-of-one departure. With a realistic mix (dozens of present users, a
    // handful of genuine departures) and the full default budget (every linked user reached in one
    // tick, no rotation involved), ordinary offboarding must actually go through.
    it('deactivates every genuine departure among dozens of present users, under the full default budget', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)

        const present = await Promise.all(
            Array.from({ length: 30 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `dd000000-0000-0000-0000-${String(i).padStart(12, '0')}` })),
        )
        const departed = await Promise.all(
            Array.from({ length: 3 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `ee000000-0000-0000-0000-${String(i).padStart(12, '0')}` })),
        )

        const departedSubjects = new Set(departed.map((u) => u.subject))
        searchBySubject.mockImplementation(({ subject }: { subject: string }) => {
            if (departedSubjects.has(subject)) {
                return Promise.resolve(null)
            }
            return Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` })
        })

        await reconcile()

        for (const { userId } of departed) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.status).toBe(UserStatus.INACTIVE)
        }
        for (const { userId } of present) {
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

// Direct coverage of the two `userService.update` side effects the reconcile design depends on,
// exercised through the real admin path (`source: 'ADMIN'`, the controller's own default) rather
// than only inferred from reconcile's own end-to-end behavior.
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

// The per-platform time budget slices into `linkedIdentities` in `lastReconciledAt` order
// (`NULLS FIRST`, `id` as a tie-break) — a slow/huge directory must not starve the exact same
// prefix of users every single tick, forever. A fake, injectable clock (`Date.now` spied to a
// counter this test advances itself, one fixed step per `searchBySubject` call) makes a tiny
// `LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS` deterministically only cover a strict subset of the
// linked users each run, with no real `setTimeout` delay and so no timing flakiness. The
// assertion reads the actual effect reconcile leaves behind — which federated rows got a fresh
// `lastReconciledAt` this run — rather than counting mock calls, so it would catch a bug in the
// stamping logic itself, not only in how many times the (test-double) directory got searched.
describe('ldapReconcileService.reconcileAllPlatforms — time budget rotates across runs', () => {
    it('reconciles a different, non-overlapping subset of users on a second run than the first, under a tiny budget', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const linked = await Promise.all(Array.from({ length: 4 }, (_, i) =>
            createLinkedUser({ platformId: mockPlatform.id, subject: `c0c0c0c${i}-0000-0000-0000-000000000000` })))

        const originalGetNumber = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) {
                return 100
            }
            return originalGetNumber(prop)
        })
        let clock = 1_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => clock)
        searchBySubject.mockImplementation(({ subject }: { subject: string }) => {
            clock += 60
            return Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` })
        })

        const federatedRepo = databaseConnection().getRepository('user_federated_identity')
        const stampedSubjects = async (): Promise<Set<string>> => {
            const rows = await federatedRepo.find({ where: { platformId: mockPlatform.id } })
            return new Set(rows.filter((row) => row.lastReconciledAt !== null).map((row) => row.subject))
        }

        await reconcile()
        const firstRunStamped = await stampedSubjects()
        expect(firstRunStamped.size).toBeGreaterThan(0)
        expect(firstRunStamped.size).toBeLessThan(linked.length)

        await reconcile()
        const afterSecondRun = await stampedSubjects()
        const newlyStampedBySecondRun = [...afterSecondRun].filter((subject) => !firstRunStamped.has(subject))

        // Rotation, not re-processing the same slice: the second run reaches at least one user
        // the first run's own budget left untouched. (`newlyStampedBySecondRun` is already
        // filtered to exclude every subject `firstRunStamped` contains, by construction — a loop
        // re-asserting that filter's own postcondition over its result would prove nothing.)
        expect(newlyStampedBySecondRun.length).toBeGreaterThan(0)
    })
})

// The identity snapshot reconcile acts on for a given user is taken at the start of the tick — an
// admin re-deactivating (or reactivating) the same user can land in between that snapshot and the
// point reconcile actually writes based on it. `searchBySubject`'s own mock implementation performs
// the competing admin write as a side effect, simulating it landing at the one point in the tick
// that matters: after reconcile's own snapshot read, before its own conditional write.
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

// Splitting the search phase and the write-back phase into two independently-deadlined loops
// starves the second loop whenever the first alone consumes the whole per-tick budget: the search
// loop stops right at the deadline, and the write-back loop's own deadline check is then true on
// its very first iteration, acting on nobody even though the search already learned enough to act
// on every identity it reached. Each identity must instead be processed start-to-finish (searched,
// then reverted-or-left) before the next one is even started, under one shared deadline — so a
// tight budget still fully finishes whatever prefix of identities it does reach.
describe('ldapReconcileService.reconcileAllPlatforms — per-user processing under a tight time budget', () => {
    it('reverts every LDAP-managed ADMIN this tick actually reaches once the group no longer grants a role, and leaves an identity outside this tick both untouched and unstamped', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        await updateLdapConfig(mockPlatform.id, {
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: 'ADMIN', projects: [] }],
        })
        const linked = await Promise.all(Array.from({ length: 3 }, (_, i) =>
            createLinkedUser({ platformId: mockPlatform.id, subject: `f0f0f0f${i}-0000-0000-0000-000000000000` })))

        // A generous first pass, with everybody a member of the admin-granting group, establishes
        // the LDAP-managed ADMIN state this test then has to revert under budget pressure.
        searchBySubject.mockImplementation(({ subject }: { subject: string }) =>
            Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` }))
        resolveMemberGroupDns.mockResolvedValue(['cn=admins,dc=example,dc=com'])
        await reconcile()
        for (const { userId } of linked) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.platformRole).toBe(PlatformRole.ADMIN)
            expect(user.platformRoleManagedBy).toBe(PlatformRoleManagedBy.LDAP)
        }

        const federatedRepo = databaseConnection().getRepository('user_federated_identity')
        const rowsBefore = await Promise.all(linked.map(({ federatedId }) => federatedRepo.findOneByOrFail({ id: federatedId })))
        for (const row of rowsBefore) {
            expect(row.lastReconciledAt).not.toBeNull()
        }

        // The group no longer grants anyone a role, and a tiny, injectable-clock-driven time
        // budget only lets this tick reach a strict prefix of the three linked users. Faking only
        // `Date` (not the timer scheduler `setTimeout` etc. run on) means real Postgres/Redis I/O
        // in the reconcile call below is unaffected — only `Date.now()` (the deadline check) and
        // `new Date()` (the `markReconciled` timestamp `reconcileOnePlatform` stamps with) move
        // together, deterministically, off one fake clock. Jumping the clock forward a full
        // second before this pass starts is what makes the "not stamped" assertion below reliable
        // with no real sleep: the tight tick's own `lastReconciledAt` writes are guaranteed to be
        // strictly later than the generous pass's, however fast both actually execute.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 1000)
        resolveMemberGroupDns.mockResolvedValue([])
        const originalGetNumber = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) {
                return 100
            }
            return originalGetNumber(prop)
        })
        searchBySubject.mockImplementation(({ subject }: { subject: string }) => {
            vi.setSystemTime(Date.now() + 60)
            return Promise.resolve({ dn: `cn=${subject},dc=example,dc=com`, mail: `${subject}@example.com` })
        })

        await reconcile()

        const rowsAfter = await Promise.all(linked.map(({ federatedId }) => federatedRepo.findOneByOrFail({ id: federatedId })))
        const results = linked.map((user, index) => ({
            userId: user.userId,
            // `lastReconciledAt` comes back from TypeORM as a `Date` object, not a string — two
            // separately-fetched `Date` instances are never `===`/`!==`-equal by reference even
            // when they represent the exact same instant, so the timestamps themselves (via
            // `getTime()`) are what must be compared, not the objects.
            reachedThisTick: rowsAfter[index].lastReconciledAt?.getTime() !== rowsBefore[index].lastReconciledAt?.getTime(),
        }))
        const reached = results.filter((result) => result.reachedThisTick)
        const untouched = results.filter((result) => !result.reachedThisTick)
        // The whole point of this test: under the old split-loop design, `reached` would be empty
        // here — the search loop alone would exhaust the budget, and the separate write-back loop
        // would revert nobody even though every one of these identities was already known to no
        // longer be in the group.
        expect(reached.length).toBeGreaterThan(0)
        expect(untouched.length).toBeGreaterThan(0)

        for (const { userId } of reached) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.platformRole).toBe(PlatformRole.MEMBER)
        }
        for (const { userId } of untouched) {
            const user = await userService(log).getOrThrow({ id: userId })
            expect(user.platformRole).toBe(PlatformRole.ADMIN)
        }
    })
})

// The safety valve must be judged against the slice this tick actually processed, not only
// the platform's full ACTIVE population — otherwise a directory-wide misconfiguration (a wrong
// `baseDn` making every user look gone) can still slip a small, valve-respecting fraction of
// ACTIVE users through per tick, and enough ticks add up to most of the platform being
// deactivated despite the valve never tripping on any single run judged platform-wide. 100 linked
// users, a time budget an injectable clock limits to a handful per tick, and every one of them
// reported "gone": the slice-local share (all of a ~4-person slice) is far over 20%, even though
// the platform-wide share (~4 of 100) would not be.
describe('ldapReconcileService.reconcileAllPlatforms — safety valve trips per-slice even when the platform-wide share would allow it', () => {
    it('trips the valve on both of two consecutive budget-limited ticks and deactivates nobody either time', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        await saveEnabledLdapConfig(mockPlatform.id)
        const linked = await Promise.all(
            Array.from({ length: 100 }, (_, i) => createLinkedUser({ platformId: mockPlatform.id, subject: `9${String(i).padStart(3, '0')}0000-0000-0000-0000-000000000000` })),
        )

        const originalGetNumber = system.getNumber.bind(system)
        vi.spyOn(system, 'getNumber').mockImplementation((prop) => {
            if (prop === AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) {
                return 200
            }
            return originalGetNumber(prop)
        })
        let clock = 10_000_000
        vi.spyOn(Date, 'now').mockImplementation(() => clock)
        searchBySubject.mockImplementation(() => {
            clock += 60
            return Promise.resolve(null)
        })

        await reconcile()
        for (const { userId } of linked) {
            expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.ACTIVE)
        }

        await reconcile()
        for (const { userId } of linked) {
            expect((await userService(log).getOrThrow({ id: userId })).status).toBe(UserStatus.ACTIVE)
        }
    })
})

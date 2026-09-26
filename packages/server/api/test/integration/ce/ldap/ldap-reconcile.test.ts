import { apId, FederatedIdentityProvider, UserIdentityProvider, UserStatus } from '@aiqadam/shared'
import pino from 'pino'
import { userFederatedIdentityService } from '../../../../src/app/authentication/federated-identity/user-federated-identity-service'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
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
})

async function saveEnabledLdapConfig(platformId: string): Promise<void> {
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
        },
    })
}

async function createLinkedUser({ platformId, subject }: { platformId: string, subject: string }): Promise<{ userId: string, federatedId: string }> {
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
    return { userId: user.id, federatedId: federated.id }
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
})

import { apId, FederatedIdentityProvider, LdapTestStage, PlatformRole, UserIdentityProvider, UserStatus } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LdapStageError } from '../../../../src/app/authentication/ldap/ldap-stage-error'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { createMockUserIdentity, mockAndSaveBasicSetup, mockBasicUser } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Everything except the LDAP wire protocol runs for real: real Postgres rows, real
// `ldapAuthnService` orchestration, real HTTP round trip. Only `ldapClient` — the thin `ldapts`
// wrapper that would otherwise need a live directory — is a test double, so this exercises the
// full JIT/link/collision decision tree and the token-minting path without a running LDAP server.
// A separate, opt-in suite (`ldap-openldap.test.ts`) covers the parts only a real directory can
// prove: the wire protocol itself and TLS certificate verification.
const connect = vi.fn()
const serviceBind = vi.fn()
const searchForUser = vi.fn()
const bindAsUser = vi.fn()
const resolveMemberGroupDns = vi.fn()

vi.mock('../../../../src/app/authentication/ldap/ldap-client', () => ({
    ldapClient: {
        connect: (...args: unknown[]) => connect(...args),
        serviceBind: (...args: unknown[]) => serviceBind(...args),
        searchForUser: (...args: unknown[]) => searchForUser(...args),
        bindAsUser: (...args: unknown[]) => bindAsUser(...args),
        withConnectionSlot: (fn: () => unknown) => fn(),
        // Group mapping (Phase 2) reads this on every sign-in; the mock directory entry never
        // carries `memberOf`, so no group DNs is the correct, non-crashing default here. A `vi.fn()`
        // (not a static resolver) so round-3's added cases can override it per test.
        resolveMemberGroupDns: (...args: unknown[]) => resolveMemberGroupDns(...args),
    },
}))

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
    ctx = await createTestContext(app!)
    connect.mockReset().mockResolvedValue({ unbind: vi.fn().mockResolvedValue(undefined) })
    serviceBind.mockReset().mockResolvedValue(undefined)
    searchForUser.mockReset()
    bindAsUser.mockReset()
    resolveMemberGroupDns.mockReset().mockResolvedValue([])
})

afterEach(() => {
    vi.clearAllMocks()
})

const DIRECTORY_ENTRY = {
    dn: 'uid=jdoe,dc=example,dc=com',
    entryUUID: '11111111-1111-1111-1111-111111111111',
    mail: 'jdoe@example.com',
    givenName: 'Jane',
    sn: 'Doe',
}

async function saveLdapConfig(overrides: Record<string, unknown> = {}): Promise<void> {
    const bindPassword = await encryptUtils.encryptString('bind-secret')
    await databaseConnection().getRepository('platform_ldap_config').save({
        id: apId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        platformId: ctx.platform.id,
        bindPassword,
        caCertificate: null,
        config: {
            url: 'ldaps://ldap.example.com:636',
            tlsMode: 'ldaps',
            baseDn: 'dc=example,dc=com',
            bindDn: 'cn=service,dc=example,dc=com',
            userFilter: '(uid={username})',
            attributeMap: {
                subject: 'entryUUID',
                email: 'mail',
                firstName: 'givenName',
                lastName: 'sn',
            },
            tlsVerify: true,
            jitProvisioning: true,
            linkExistingByEmail: false,
            sessionTtlSeconds: 43200,
            enabled: true,
            ...overrides,
        },
    })
}

async function signIn({ username, password }: SignInParams) {
    return app!.inject({
        method: 'POST',
        url: '/api/v1/authn/ldap/sign-in',
        body: { username, password },
    })
}

function decodeExp(token: string): number {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return payload.exp
}

describe('LDAP sign-in', () => {
    it('JIT-provisions a new user on first successful sign-in', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.token).toBeDefined()
        expect(body.email).toBe('jdoe@example.com')

        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' })
        expect(identity?.provider).toBe(UserIdentityProvider.LDAP)

        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({
            platformId: ctx.platform.id,
            subject: DIRECTORY_ENTRY.entryUUID,
        })
        expect(federated).not.toBeNull()
    })

    // Round 3 (app-sec, missing-test finding #8): every other sign-in test in this file resolves
    // zero groups (the mocked default), so none of them ever actually exercised `applyMapping`
    // being called with a non-empty `memberGroupDns` from the sign-in path itself — only the
    // DB-level `ldapGroupMappingService.applyMapping` unit/integration tests did.
    it('applies a group mapping resolved during sign-in when the directory reports a non-empty group list', async () => {
        await saveLdapConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        resolveMemberGroupDns.mockResolvedValue(['cn=admins,dc=example,dc=com'])

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const identity = await databaseConnection().getRepository('user_identity').findOneByOrFail({ email: 'jdoe@example.com' })
        const user = await databaseConnection().getRepository('user').findOneBy({ platformId: ctx.platform.id, identityId: identity.id })
        expect(user?.platformRole).toBe(PlatformRole.ADMIN)
    })

    // Round 3 (app-sec, missing-test finding #8): a broken group search (a bad `groupSearchFilter`,
    // a transient directory hiccup on the nested-group search) must never fail the sign-in itself —
    // only the mapping re-application it would have driven.
    it('still succeeds a sign-in when group resolution throws', async () => {
        await saveLdapConfig({
            groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
        })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        resolveMemberGroupDns.mockRejectedValue(new Error('simulated group search failure'))

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().token).toBeDefined()
        const identity = await databaseConnection().getRepository('user_identity').findOneByOrFail({ email: 'jdoe@example.com' })
        const user = await databaseConnection().getRepository('user').findOneBy({ platformId: ctx.platform.id, identityId: identity.id })
        // Group resolution failed, so the mapping was never applied — the JIT-provisioned default
        // (MEMBER) stands, proving the sign-in itself did not fail, and also did not misread the
        // failure as "resolved to no groups".
        expect(user?.platformRole).toBe(PlatformRole.MEMBER)
    })

    it('refuses an INACTIVE user, even with correct credentials', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        const first = await signIn({ username: 'jdoe', password: 'correct-password' })
        expect(first.statusCode).toBe(StatusCodes.OK)
        await databaseConnection().getRepository('user').update({ id: first.json().id }, { status: UserStatus.INACTIVE })

        const second = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(second.json().code).toBe('USER_IS_INACTIVE')
    })

    it('refuses JIT provisioning when jitProvisioning is off, for an unrecognized directory user', async () => {
        await saveLdapConfig({ jitProvisioning: false })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('INVALID_CREDENTIALS')
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' })
        expect(identity).toBeNull()
    })

    it('returns LDAP_EMAIL_ATTRIBUTE_MISSING when the matched entry has no readable email attribute', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue({ ...DIRECTORY_ENTRY, mail: undefined })
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_EMAIL_ATTRIBUTE_MISSING')
    })

    it('returns INVALID_CREDENTIALS for a wrong password without revealing the user was found', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.USER_BIND, message: 'Invalid credentials', ldapResultCode: 49 }))

        const response = await signIn({ username: 'jdoe', password: 'wrong-password' })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('returns the same INVALID_CREDENTIALS for an unknown username', async () => {
        await saveLdapConfig()
        searchForUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'No matching entry was found', notFound: true }))
        bindAsUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.USER_BIND, message: 'Invalid credentials', ldapResultCode: 49 }))

        const response = await signIn({ username: 'nobody', password: 'irrelevant' })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
        // Anti-timing-oracle (app-sec L2): an unknown username must still pay for a second
        // connect+bind round trip, the same one a known-username-wrong-password case pays for via
        // its own real user bind — otherwise "not found" measurably returns faster than "found, but
        // wrong password", which is itself a way to enumerate valid usernames without ever reading
        // the (identical) response body.
        expect(bindAsUser).toHaveBeenCalledTimes(1)
        const [dummyBindCall] = bindAsUser.mock.calls
        expect(dummyBindCall[0].userDn).not.toBe('nobody')
    })

    it('also pays the dummy-bind cost for a matched entry with a missing subject attribute', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue({ ...DIRECTORY_ENTRY, entryUUID: undefined })
        bindAsUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.USER_BIND, message: 'Invalid credentials', ldapResultCode: 49 }))

        const response = await signIn({ username: 'jdoe', password: 'irrelevant' })

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
        // Round 3: an entry that *matched* but has no readable subject attribute never reaches a
        // real user bind either — the same timing residual as "not found" (both bail out after one
        // connect+search), so it must pay the same dummy connect+bind cost before returning.
        expect(bindAsUser).toHaveBeenCalledTimes(1)
        const [dummyBindCall] = bindAsUser.mock.calls
        expect(dummyBindCall[0].userDn).not.toBe(DIRECTORY_ENTRY.dn)
    })

    it('returns LDAP_BIND_ACCOUNT_REJECTED when the service account bind fails', async () => {
        await saveLdapConfig()
        serviceBind.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.SERVICE_BIND, message: 'The configured bind account was rejected by the directory', ldapResultCode: 49 }))

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_BIND_ACCOUNT_REJECTED')
    })

    it('returns LDAP_DIRECTORY_UNREACHABLE when the directory cannot be reached', async () => {
        await saveLdapConfig()
        connect.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.CONNECT, message: 'simulated connection failure' }))

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    it('refuses to link a colliding local account when linkExistingByEmail is off', async () => {
        await saveLdapConfig({ linkExistingByEmail: false })
        await databaseConnection().getRepository('user_identity').save(
            createMockUserIdentity({ email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true }),
        )
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_ACCOUNT_COLLISION')
    })

    it('links the existing local account by email when linkExistingByEmail is on', async () => {
        await saveLdapConfig({ linkExistingByEmail: true })
        const existingIdentity = createMockUserIdentity({ email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true })
        await databaseConnection().getRepository('user_identity').save(existingIdentity)
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ id: existingIdentity.id })
        expect(identity?.provider).toBe(UserIdentityProvider.LDAP)
    })

    it('an LDAP-linked identity can no longer sign in with its old local password', async () => {
        await saveLdapConfig({ linkExistingByEmail: true })
        const existingIdentity = createMockUserIdentity({ email: 'jdoe@example.com', password: 'old-local-password', provider: UserIdentityProvider.EMAIL, verified: true })
        await databaseConnection().getRepository('user_identity').save(existingIdentity)
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        await signIn({ username: 'jdoe', password: 'correct-password' })

        const localSignIn = await app!.inject({
            method: 'POST',
            url: '/api/v1/authentication/sign-in',
            body: { email: 'jdoe@example.com', password: 'old-local-password' },
        })

        expect(localSignIn.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('an LDAP identity cannot request a password reset OTP', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        await signIn({ username: 'jdoe', password: 'correct-password' })

        const otpResponse = await app!.inject({
            method: 'POST',
            url: '/api/v1/otp',
            body: { email: 'jdoe@example.com', type: 'PASSWORD_RESET' },
        })
        expect(otpResponse.statusCode).toBe(StatusCodes.NO_CONTENT)

        const otp = await databaseConnection().getRepository('otp').findOneBy({ type: 'PASSWORD_RESET' })
        expect(otp).toBeNull()
    })

    // B1: platform B linking-by-email an identity whose only user row lives on platform A would let
    // `/v1/authentication/switch-platform` hand out a token for A — a cross-platform takeover.
    it('refuses to link an identity whose only user is on a second platform', async () => {
        await saveLdapConfig({ linkExistingByEmail: true })
        // `POST /v1/authn/ldap/sign-in` is unauthenticated, so it resolves the platform via
        // `platformUtils.getPlatformIdForRequest` -> `getOldestPlatform` (oldest `created` wins) —
        // the same fallback single-tenant CE relies on for every public authn route. A `created`
        // in the future keeps this second platform from ever winning that race against `ctx.platform`,
        // whose own `created` is `faker.date.recent()` (i.e. in the past).
        const otherSetup = await mockAndSaveBasicSetup({ platform: { created: new Date(Date.now() + 86400000).toISOString() } })
        const { mockUserIdentity } = await mockBasicUser({
            userIdentity: { email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true },
            user: { platformId: otherSetup.mockPlatform.id, platformRole: PlatformRole.MEMBER },
        })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_ACCOUNT_COLLISION')
        const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({
            platformId: ctx.platform.id,
            subject: DIRECTORY_ENTRY.entryUUID,
        })
        expect(federated).toBeNull()
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ id: mockUserIdentity.id })
        expect(identity?.provider).toBe(UserIdentityProvider.EMAIL)
    })

    // B2: the platform owner's break-glass — no directory, however configured, may ever link or
    // adopt the owner's identity, so local password sign-in keeps working for them no matter what.
    it('never links the platform owner, even with linkExistingByEmail on', async () => {
        await databaseConnection().getRepository('user_identity').update(ctx.userIdentity.id, { email: 'jdoe@example.com' })
        await saveLdapConfig({ linkExistingByEmail: true })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_ACCOUNT_COLLISION')
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ id: ctx.userIdentity.id })
        expect(identity?.provider).toBe(UserIdentityProvider.EMAIL)
    })

    // B2: a non-owner ADMIN is just as capable of directing traffic through a directory they
    // control, so the refusal must not be scoped to the owner alone.
    it('never links a non-owner admin, even with linkExistingByEmail on', async () => {
        await saveLdapConfig({ linkExistingByEmail: true })
        const { mockUserIdentity } = await mockBasicUser({
            userIdentity: { email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true },
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.ADMIN },
        })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.json().code).toBe('LDAP_ACCOUNT_COLLISION')
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ id: mockUserIdentity.id })
        expect(identity?.provider).toBe(UserIdentityProvider.EMAIL)
    })

    // B3: an LDAP identity with no federated row for *this* platform (the user row on this
    // platform was deleted, or a previous JIT died after creating the identity but before the
    // federated row) must still be able to sign in — the fast `findBySubject` path only covers the
    // common case where that row already exists. This is never a route onto a *different*
    // platform, or a way to silently repoint a rotated `objectGUID`: both are refused
    // (`LDAP_ACCOUNT_COLLISION`), not recovered — see `assertIdentityIsNotPrivilegedElsewhere` and
    // `adoptExistingLdapIdentity`'s own subject-mismatch check.
    describe('recovery when an LDAP identity has no federated row for this platform (B3)', () => {
        it('signs in again through the fast findBySubject path unaffected', async () => {
            await saveLdapConfig()
            searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
            bindAsUser.mockResolvedValue(undefined)
            const first = await signIn({ username: 'jdoe', password: 'correct-password' })
            expect(first.statusCode).toBe(StatusCodes.OK)
            const firstUserId = first.json().id

            const second = await signIn({ username: 'jdoe', password: 'correct-password' })

            expect(second.statusCode).toBe(StatusCodes.OK)
            expect(second.json().id).toBe(firstUserId)
        })

        it('recovers after the user row is deleted, without re-scrambling a nonexistent local password', async () => {
            await saveLdapConfig()
            searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
            bindAsUser.mockResolvedValue(undefined)
            const first = await signIn({ username: 'jdoe', password: 'correct-password' })
            expect(first.statusCode).toBe(StatusCodes.OK)
            const firstUserId = first.json().id

            await databaseConnection().getRepository('user_federated_identity').delete({ platformId: ctx.platform.id })
            await databaseConnection().getRepository('project').delete({ ownerId: firstUserId })
            await databaseConnection().getRepository('user').delete({ id: firstUserId })

            const second = await signIn({ username: 'jdoe', password: 'correct-password' })

            expect(second.statusCode).toBe(StatusCodes.OK)
            const recreatedUser = await databaseConnection().getRepository('user').findOneBy({ identityId: (await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' }))!.id })
            expect(recreatedUser).not.toBeNull()
            const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({
                platformId: ctx.platform.id,
                subject: DIRECTORY_ENTRY.entryUUID,
            })
            expect(federated).not.toBeNull()
        })

        it('refuses (does not silently repoint) a rotated subject for an already-linked identity on this platform', async () => {
            await saveLdapConfig()
            searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
            bindAsUser.mockResolvedValue(undefined)
            const first = await signIn({ username: 'jdoe', password: 'correct-password' })
            expect(first.statusCode).toBe(StatusCodes.OK)

            // The directory's own subject for this entry changed under the same email (deleted and
            // recreated, or reassigned to a different real person) — `findBySubject` on the new
            // value finds nothing, so this falls to the email match and reaches
            // `adoptExistingLdapIdentity`, which must refuse rather than repoint the existing row.
            searchForUser.mockResolvedValue({ ...DIRECTORY_ENTRY, entryUUID: '99999999-9999-9999-9999-999999999999' })

            const second = await signIn({ username: 'jdoe', password: 'correct-password' })

            expect(second.json().code).toBe('LDAP_ACCOUNT_COLLISION')
            const federated = await databaseConnection().getRepository('user_federated_identity').findOneBy({ platformId: ctx.platform.id })
            expect(federated?.subject).toBe(DIRECTORY_ENTRY.entryUUID)
        })
    })

    // M2: `/switch-platform` reissuing a fresh default-lifetime token would silently undo the
    // directory admin's own session TTL every time an LDAP-signed-in user switched platforms.
    it('caps a switched-platform token so it never outlives the current LDAP session (M2)', async () => {
        // `MIN_LDAP_SESSION_TTL_SECONDS` (3600) is the schema floor — using it here is the
        // shortest session TTL `LdapConfig` will actually accept, still well under the
        // non-LDAP default token lifetime the cap is meant to beat.
        await saveLdapConfig({ sessionTtlSeconds: 3600 })
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        const signInResponse = await signIn({ username: 'jdoe', password: 'correct-password' })
        expect(signInResponse.statusCode).toBe(StatusCodes.OK)
        const { token } = signInResponse.json()
        const originalExp = decodeExp(token)

        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' })
        const secondSetup = await mockAndSaveBasicSetup()
        const secondPlatformUserId = apId()
        await databaseConnection().getRepository('user').save({
            id: secondPlatformUserId,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            status: UserStatus.ACTIVE,
            platformRole: PlatformRole.ADMIN,
            identityId: identity!.id,
            platformId: secondSetup.mockPlatform.id,
        })
        // A federated row on the second platform too — this test is about the M2 TTL cap, not the
        // app-sec squatting guard `getUserForPlatform` now enforces; without this, the switch below
        // would be refused (no federated row = no proof this identity ever signed in through the
        // second platform's own directory) before ever reaching the code this test exists to check.
        await databaseConnection().getRepository('user_federated_identity').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            platformId: secondSetup.mockPlatform.id,
            userId: secondPlatformUserId,
            provider: FederatedIdentityProvider.LDAP,
            subject: '22222222-2222-2222-2222-222222222222',
        })

        const switchResponse = await app!.inject({
            method: 'POST',
            url: '/api/v1/authentication/switch-platform',
            headers: { authorization: `Bearer ${token}` },
            body: { platformId: secondSetup.mockPlatform.id },
        })

        expect(switchResponse.statusCode).toBe(StatusCodes.OK)
        const switchedExp = decodeExp(switchResponse.json().token)
        expect(switchedExp).toBeLessThanOrEqual(originalExp)
    })
})

type SignInParams = {
    username: string
    password: string
}

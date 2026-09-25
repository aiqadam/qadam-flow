import { apId, LdapTestStage, UserIdentityProvider } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LdapStageError } from '../../../../src/app/authentication/ldap/ldap-stage-error'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { createMockUserIdentity } from '../../../helpers/mocks'
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

vi.mock('../../../../src/app/authentication/ldap/ldap-client', () => ({
    ldapClient: {
        connect: (...args: unknown[]) => connect(...args),
        serviceBind: (...args: unknown[]) => serviceBind(...args),
        searchForUser: (...args: unknown[]) => searchForUser(...args),
        bindAsUser: (...args: unknown[]) => bindAsUser(...args),
        withConnectionSlot: (fn: () => unknown) => fn(),
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

async function signIn(username: string, password: string) {
    return app!.inject({
        method: 'POST',
        url: '/api/v1/authn/ldap/sign-in',
        body: { username, password },
    })
}

describe('LDAP sign-in', () => {
    it('JIT-provisions a new user on first successful sign-in', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn('jdoe', 'correct-password')

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

    it('returns INVALID_CREDENTIALS for a wrong password without revealing the user was found', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.USER_BIND, message: 'Invalid credentials', ldapResultCode: 49 }))

        const response = await signIn('jdoe', 'wrong-password')

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('returns the same INVALID_CREDENTIALS for an unknown username', async () => {
        await saveLdapConfig()
        searchForUser.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'No matching entry was found' }))

        const response = await signIn('nobody', 'irrelevant')

        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('returns LDAP_BIND_ACCOUNT_REJECTED when the service account bind fails', async () => {
        await saveLdapConfig()
        serviceBind.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.SERVICE_BIND, message: 'The configured bind account was rejected by the directory', ldapResultCode: 49 }))

        const response = await signIn('jdoe', 'correct-password')

        expect(response.json().code).toBe('LDAP_BIND_ACCOUNT_REJECTED')
    })

    it('returns LDAP_DIRECTORY_UNREACHABLE when the directory cannot be reached', async () => {
        await saveLdapConfig()
        connect.mockRejectedValue(new LdapStageError({ stage: LdapTestStage.CONNECT, message: 'simulated connection failure' }))

        const response = await signIn('jdoe', 'correct-password')

        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    it('refuses to link a colliding local account when linkExistingByEmail is off', async () => {
        await saveLdapConfig({ linkExistingByEmail: false })
        await databaseConnection().getRepository('user_identity').save(
            createMockUserIdentity({ email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true }),
        )
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn('jdoe', 'correct-password')

        expect(response.json().code).toBe('LDAP_ACCOUNT_COLLISION')
    })

    it('links the existing local account by email when linkExistingByEmail is on', async () => {
        await saveLdapConfig({ linkExistingByEmail: true })
        const existingIdentity = createMockUserIdentity({ email: 'jdoe@example.com', provider: UserIdentityProvider.EMAIL, verified: true })
        await databaseConnection().getRepository('user_identity').save(existingIdentity)
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn('jdoe', 'correct-password')

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
        await signIn('jdoe', 'correct-password')

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
        await signIn('jdoe', 'correct-password')

        const otpResponse = await app!.inject({
            method: 'POST',
            url: '/api/v1/otp',
            body: { email: 'jdoe@example.com', type: 'PASSWORD_RESET' },
        })
        expect(otpResponse.statusCode).toBe(StatusCodes.NO_CONTENT)

        const otp = await databaseConnection().getRepository('otp').findOneBy({ type: 'PASSWORD_RESET' })
        expect(otp).toBeNull()
    })
})

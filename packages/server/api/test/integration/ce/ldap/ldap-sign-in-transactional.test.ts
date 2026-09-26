import { apId } from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// B3: JIT-provisioning creates an identity, a user (+ project) and a federated-identity row across
// three different tables. A crash between any two of them must never leave a partial result behind
// — an identity with no federated row is a permanently unreachable account (the email is "taken"
// but nothing can sign in as it; see `ldap-authn-service.ts`'s comment on `resolveUser`). This file
// exists, separately from `ldap-sign-in.test.ts`, purely to inject that one mid-transaction failure
// without touching the mocking setup every other LDAP sign-in test relies on.
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
        resolveMemberGroupDns: () => Promise.resolve([]),
    },
}))

const federatedCreateFailure = vi.hoisted(() => ({ shouldFail: false }))

vi.mock('../../../../src/app/authentication/federated-identity/user-federated-identity-service', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/authentication/federated-identity/user-federated-identity-service')>()
    return {
        ...actual,
        userFederatedIdentityService: (log: FastifyBaseLogger) => {
            const real = actual.userFederatedIdentityService(log)
            return {
                ...real,
                create: async (params: Parameters<typeof real.create>[0]) => {
                    if (federatedCreateFailure.shouldFail) {
                        throw new Error('simulated mid-transaction failure')
                    }
                    return real.create(params)
                },
            }
        },
    }
})

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
    federatedCreateFailure.shouldFail = false
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

async function saveLdapConfig(): Promise<void> {
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

describe('LDAP sign-in transactional rollback (B3)', () => {
    it('leaves nothing half-created when JIT provisioning fails midway', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)
        federatedCreateFailure.shouldFail = true

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).not.toBe(StatusCodes.OK)
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' })
        expect(identity).toBeNull()
        const user = await databaseConnection().getRepository('user').findOneBy({ platformId: ctx.platform.id })
        expect(user?.id).toBe(ctx.user.id)
    })

    it('can sign in normally once the failure is no longer injected', async () => {
        await saveLdapConfig()
        searchForUser.mockResolvedValue(DIRECTORY_ENTRY)
        bindAsUser.mockResolvedValue(undefined)

        const response = await signIn({ username: 'jdoe', password: 'correct-password' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const identity = await databaseConnection().getRepository('user_identity').findOneBy({ email: 'jdoe@example.com' })
        expect(identity).not.toBeNull()
    })
})

type SignInParams = {
    username: string
    password: string
}

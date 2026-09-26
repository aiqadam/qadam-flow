import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// M1 (connection leak): the previous `/test` implementation only called `client.unbind()` on its
// two success returns, so a `serviceBind`/`searchForUser` failure — the entire reason an admin
// clicks "test connection" in the first place — leaked the socket every time. This file mocks
// `ldapClient` (rather than reaching a real directory, like `ldap-config.test.ts`'s own `/test`
// case does for the unreachable-host path) purely so it can assert `unbind` was actually called on
// the failure path, which a real directory's response alone cannot prove.
const unbind = vi.fn().mockResolvedValue(undefined)
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
    ctx = await createTestContext(app!)
    connect.mockReset().mockResolvedValue({ unbind })
    serviceBind.mockReset()
    searchForUser.mockReset()
    bindAsUser.mockReset()
    unbind.mockClear()
})

afterEach(() => {
    vi.clearAllMocks()
})

const validConfig = (overrides: Record<string, unknown> = {}) => ({
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
    bindPassword: 'super-secret-bind-password',
    ...overrides,
})

describe('/v1/platform-ldap-configs/test connection cleanup (M1)', () => {
    it('unbinds even when the service bind fails', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig())
        serviceBind.mockRejectedValue(new Error('simulated service bind failure'))

        const response = await ctx.post('/v1/platform-ldap-configs/test', {})

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().success).toBe(false)
        expect(unbind).toHaveBeenCalledTimes(1)
    })

    it('unbinds even when the user search fails', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig())
        serviceBind.mockResolvedValue(undefined)
        searchForUser.mockRejectedValue(new Error('simulated search failure'))

        const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'irrelevant' })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().success).toBe(false)
        expect(unbind).toHaveBeenCalledTimes(1)
    })

    it('still unbinds exactly once on the success path', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig())
        serviceBind.mockResolvedValue(undefined)

        const response = await ctx.post('/v1/platform-ldap-configs/test', {})

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().success).toBe(true)
        expect(unbind).toHaveBeenCalledTimes(1)
    })
})

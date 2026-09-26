import { LdapTestStage, PlatformRole } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// `ldap-config.test.ts` covers everything about `/test` that does not need a directory round trip
// (CRUD, M3 re-supply, B2 owner-only). This file mocks `ldapClient` — the same passthrough shape
// `ldap-sign-in.test.ts` uses — to cover the two stages that do: the "nothing saved yet" case, and
// `/test`'s own attribute-resolvability check on a successful search.
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

async function saveConfig(overrides: Record<string, unknown> = {}): Promise<void> {
    const response = await ctx.post('/v1/platform-ldap-configs', {
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
        tlsVerify: true,
        jitProvisioning: true,
        linkExistingByEmail: false,
        sessionTtlSeconds: 43200,
        enabled: true,
        ...overrides,
    })
    if (response.statusCode !== StatusCodes.OK) {
        throw new Error(`upsert failed while preparing the test fixture: ${response.statusCode} ${response.body}`)
    }
}

describe('POST /v1/platform-ldap-configs/test', () => {
    it('reports NOT_CONFIGURED, distinct from an ALLOW_LIST failure, when nothing is saved yet', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs/test', {})
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(false)
        expect(body.stage).toBe(LdapTestStage.NOT_CONFIGURED)
    })

    it('reports SUCCESS with the service account alone when no test credentials are given', async () => {
        await saveConfig()
        const response = await ctx.post('/v1/platform-ldap-configs/test', {})
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(true)
        expect(body.stage).toBe(LdapTestStage.SUCCESS)
        expect(bindAsUser).not.toHaveBeenCalled()
    })

    // A test that only proves the search matched an entry says nothing about the one failure mode
    // a real sign-in would hit next: a matched entry with a missing/unreadable email attribute.
    it('reports a SEARCH-stage failure, not SUCCESS, when the matched entry has no readable email attribute', async () => {
        await saveConfig()
        searchForUser.mockResolvedValue({ dn: 'uid=jdoe,dc=example,dc=com', entryUUID: '11111111-1111-1111-1111-111111111111' })
        const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(false)
        expect(body.stage).toBe(LdapTestStage.SEARCH)
        expect(bindAsUser).not.toHaveBeenCalled()
    })

    it('reports a SEARCH-stage failure, not SUCCESS, when the matched entry has no readable subject attribute', async () => {
        await saveConfig()
        searchForUser.mockResolvedValue({ dn: 'uid=jdoe,dc=example,dc=com', mail: 'jdoe@example.com' })
        const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(false)
        expect(body.stage).toBe(LdapTestStage.SEARCH)
        expect(bindAsUser).not.toHaveBeenCalled()
    })

    it('reports SUCCESS, and calls bindAsUser exactly once, when the matched entry resolves both attributes', async () => {
        await saveConfig()
        searchForUser.mockResolvedValue({
            dn: 'uid=jdoe,dc=example,dc=com',
            entryUUID: '11111111-1111-1111-1111-111111111111',
            mail: 'jdoe@example.com',
        })
        bindAsUser.mockResolvedValue(undefined)
        const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(true)
        expect(body.stage).toBe(LdapTestStage.SUCCESS)
        expect(bindAsUser).toHaveBeenCalledTimes(1)
    })

    // Round 2 (app-sec finding #3): `/test` exercises the group search as its own reported stage,
    // but only when the platform actually has group mappings configured.
    describe('group-search stage (exercised only when groupMappings is non-empty)', () => {
        it('never calls resolveMemberGroupDns when the platform has no group mappings', async () => {
            await saveConfig()
            searchForUser.mockResolvedValue({
                dn: 'uid=jdoe,dc=example,dc=com',
                entryUUID: '11111111-1111-1111-1111-111111111111',
                mail: 'jdoe@example.com',
            })
            bindAsUser.mockResolvedValue(undefined)

            const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })

            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().stage).toBe(LdapTestStage.SUCCESS)
            expect(resolveMemberGroupDns).not.toHaveBeenCalled()
        })

        it('reports its own GROUP_SEARCH-stage failure, not SUCCESS, when group resolution fails and mappings exist', async () => {
            await saveConfig({
                groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
            })
            searchForUser.mockResolvedValue({
                dn: 'uid=jdoe,dc=example,dc=com',
                entryUUID: '11111111-1111-1111-1111-111111111111',
                mail: 'jdoe@example.com',
            })
            resolveMemberGroupDns.mockRejectedValue(new Error('simulated nested-group search failure'))

            const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })

            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json()
            expect(body.success).toBe(false)
            expect(body.stage).toBe(LdapTestStage.GROUP_SEARCH)
            expect(bindAsUser).not.toHaveBeenCalled()
        })

        it('calls resolveMemberGroupDns and still reports SUCCESS when group mappings exist and resolution succeeds', async () => {
            await saveConfig({
                groupMappings: [{ groupDn: 'cn=admins,dc=example,dc=com', platformRole: PlatformRole.ADMIN, projects: [] }],
            })
            searchForUser.mockResolvedValue({
                dn: 'uid=jdoe,dc=example,dc=com',
                entryUUID: '11111111-1111-1111-1111-111111111111',
                mail: 'jdoe@example.com',
            })
            bindAsUser.mockResolvedValue(undefined)

            const response = await ctx.post('/v1/platform-ldap-configs/test', { username: 'jdoe', password: 'correct-password' })

            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().stage).toBe(LdapTestStage.SUCCESS)
            expect(resolveMemberGroupDns).toHaveBeenCalledTimes(1)
        })
    })
})

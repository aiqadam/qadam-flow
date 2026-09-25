import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

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

describe('Platform LDAP config API', () => {
    it('returns null when no config is saved yet', async () => {
        const response = await ctx.get('/v1/platform-ldap-configs')
        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json()).toBeNull()
    })

    it('creates a config and never returns the bind password', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs', validConfig())
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.hasBindPassword).toBe(true)
        expect(body.hasCaCertificate).toBe(false)
        expect(body).not.toHaveProperty('bindPassword')
        expect(body).not.toHaveProperty('caCertificate')
        expect(body.config.enabled).toBe(false)
        expect(body.config.sessionTtlSeconds).toBe(43200)
    })

    it('rejects a plaintext ldap:// URL paired with tlsMode ldaps', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs', validConfig({
            url: 'ldap://ldap.example.com:389',
            tlsMode: 'ldaps',
        }))
        expect(response.statusCode).not.toBe(StatusCodes.OK)
    })

    it('rejects a userFilter with no {username} placeholder', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs', validConfig({
            userFilter: '(uid=fixed)',
        }))
        expect(response.statusCode).not.toBe(StatusCodes.OK)
    })

    it('rejects a userFilter with two {username} placeholders', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs', validConfig({
            userFilter: '(|(uid={username})(mail={username}))',
        }))
        expect(response.statusCode).not.toBe(StatusCodes.OK)
    })

    it('keeps the stored bind password when it is omitted from an update', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig())
        const update = await ctx.post('/v1/platform-ldap-configs', {
            baseDn: 'dc=example,dc=com',
            bindDn: 'cn=service,dc=example,dc=com',
            url: 'ldaps://ldap.example.com:636',
            tlsMode: 'ldaps',
            userFilter: '(uid={username})',
            attributeMap: {
                subject: 'entryUUID',
                email: 'mail',
                firstName: 'givenName',
                lastName: 'sn',
            },
            enabled: true,
        })
        expect(update.statusCode).toBe(StatusCodes.OK)
        expect(update.json().hasBindPassword).toBe(true)
        expect(update.json().config.enabled).toBe(true)
    })

    it('deletes the config', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig())
        const del = await ctx.delete('/v1/platform-ldap-configs')
        expect(del.statusCode).toBe(StatusCodes.NO_CONTENT)
        const get = await ctx.get('/v1/platform-ldap-configs')
        expect(get.json()).toBeNull()
    })

    it('rejects a CA certificate that is not a valid PEM', async () => {
        const response = await ctx.post('/v1/platform-ldap-configs', validConfig({
            caCertificate: 'not-a-real-certificate',
        }))
        expect(response.statusCode).not.toBe(StatusCodes.OK)
    })

    it('reports the failing stage from /test when the directory is unreachable', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig({
            url: 'ldaps://ldap.invalid.internal.example:636',
        }))
        const response = await ctx.post('/v1/platform-ldap-configs/test', {})
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.success).toBe(false)
        expect(['ALLOW_LIST', 'CONNECT']).toContain(body.stage)
    })
})

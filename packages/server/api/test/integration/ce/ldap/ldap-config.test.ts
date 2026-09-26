import { PlatformRole, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import pino from 'pino'
import { ldapConfigService } from '../../../../src/app/authentication/ldap/ldap-config-service'
import { generateMockToken } from '../../../helpers/auth'
import { mockBasicUser } from '../../../helpers/mocks'
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

// Delta review: a non-PEM string was rejected by `assertValidPem` before the owner gate ever ran,
// so on the parent (buggy) commit this returned 400, not the 403 the owner gate itself would have
// produced — a false-red test that didn't actually prove the gate. This is a real, valid,
// self-signed certificate (structurally valid PEM, not chained to any real CA) so the only thing
// that can reject the request is the owner gate.
const STATIC_TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDKTCCAhGgAwIBAgIUNv0V9QyocOGLv3oGffDbcwnqbxswDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYbGRhcC1jb25maWctdGVzdC1maXh0dXJlMCAXDTI2MDky
NjA2MTczNFoYDzIxMjYwOTAyMDYxNzM0WjAjMSEwHwYDVQQDDBhsZGFwLWNvbmZp
Zy10ZXN0LWZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDb
KxPKEQQwfdIQ2uxTuQKPJ7DobnfbYgQfaG37ToR0xglHUulnlL6mYEVcak3L1Cq/
rGhMfaldU0jkCyEZPfFTGLWxHKOm6HH1KtqBjVRuWFS7cSwQGDnob6ImSxUJLghM
niDZiHr+5DMg1Ay254pcxz9j/BXXoySWLuO/E/GQm6AXZKnG5CBFl4GmRMauHuA2
n0fvgkrJYNyEDJAFrJAto7hGWEYscaoCORPUbYDVY6zpdVYr+Nh/PJLzx1NzQreY
d+oqZOblUDbggDTsMD7UfPAUdiNjspBfYP+1fPYQWgZHHTjV0wWX1+bYlEt3xKgZ
XYthOGxjCOJXubsm+cBlAgMBAAGjUzBRMB0GA1UdDgQWBBRRj58wA7bN650yMo1H
4XkytD7iYzAfBgNVHSMEGDAWgBRRj58wA7bN650yMo1H4XkytD7iYzAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQDP26Mm+23Zb+cdsHe3rNtvAdAK
RtxX8zIpHAU3uNtKk/er/mDrPz8AiLYMatKWIUoXNzuqlrbtMi8GEytMlQEUtJrM
AdtgtJhbRwl2rIiLns9h4FfTbfYaIPL7pxHVmqOuT8YgVP5LEvMrc6DOXDDk7yz1
TCcN8qh/Ltgq1eRDhTQKqcQH8faBbLzoVQESOm96ddnk/I6S6VPQkvAMgMyYrmJN
TYwHzBhuUdDOyZnehsJI/Xe3l74BsroxH2gra26zx5a+oq8WDdPwQXkmQK7xzeb9
pBRrTmZpDlqDjBH7Ee9OtUx5zdp28mFJD9nzj77vYdwNw4Vj7qnECajWd+3h
-----END CERTIFICATE-----
`

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
        // Asserts the specific issue key rather than just "not OK": a generic status-code check
        // alone would still pass if the schema started rejecting this request for the wrong
        // reason (or stopped validating the URL/tlsMode pairing at all and failed elsewhere).
        expect(response.json().message).toContain('invalidLdapUrlForTlsMode')
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

    // Regression test for a real bug an actual-directory run caught: `upsert` used to encrypt
    // these two plain-string secrets with `encryptObject` (which JSON-stringifies first — the
    // right pairing for an object-shaped secret like `ai-provider`'s `auth`, wrong for a bare
    // string), while the sign-in path decrypted with `decryptString` (no JSON.parse). The mismatch
    // silently left literal quote characters around the recovered value — invisible to every other
    // test here, since none of them decrypt a stored secret and compare it back to the plaintext.
    it('round-trips the bind password byte-for-byte through encryption', async () => {
        await ctx.post('/v1/platform-ldap-configs', validConfig({
            bindPassword: 'super-secret-bind-password',
        }))
        const resolved = await ldapConfigService(pino({ level: 'silent' })).getResolvedForSignIn({ platformId: ctx.platform.id })
        expect(resolved?.bindPassword).toBe('super-secret-bind-password')
        expect(resolved?.bindPassword).not.toContain('"')
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

    // M3: a stored bind password is otherwise exfiltratable by repointing the connection at an
    // attacker-controlled host and letting the server dial out with the old bind credentials.
    describe('bind password re-supply on connection-sensitive changes (M3)', () => {
        it('rejects a URL change without re-supplying the bind password', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig())
            const update = await ctx.post('/v1/platform-ldap-configs', {
                ...validConfig(),
                url: 'ldaps://attacker.example.com:636',
                bindPassword: undefined,
            })
            expect(update.statusCode).not.toBe(StatusCodes.OK)
        })

        it('rejects a bindDn change without re-supplying the bind password', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig())
            const update = await ctx.post('/v1/platform-ldap-configs', {
                ...validConfig(),
                bindDn: 'cn=other,dc=example,dc=com',
                bindPassword: undefined,
            })
            expect(update.statusCode).not.toBe(StatusCodes.OK)
        })

        it('rejects a tlsVerify change without re-supplying the bind password', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ tlsVerify: true }))
            const update = await ctx.post('/v1/platform-ldap-configs', {
                ...validConfig(),
                tlsVerify: false,
                bindPassword: undefined,
            })
            expect(update.statusCode).not.toBe(StatusCodes.OK)
        })

        it('allows an unrelated field change without re-supplying the bind password', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig())
            const update = await ctx.post('/v1/platform-ldap-configs', {
                ...validConfig(),
                jitProvisioning: false,
                bindPassword: undefined,
            })
            expect(update.statusCode).toBe(StatusCodes.OK)
        })

        it('rejects supplying a CA certificate for the first time without re-supplying the bind password', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig())
            const update = await ctx.post('/v1/platform-ldap-configs', {
                ...validConfig(),
                caCertificate: '-----BEGIN CERTIFICATE-----\nMIIBAjCB',
                bindPassword: undefined,
            })
            expect(update.statusCode).not.toBe(StatusCodes.OK)
        })
    })

    // B2: only the platform owner may enable linking a directory entry to an existing local
    // account by email — any other admin could otherwise use the flag to take over accounts they
    // do not own.
    describe('linkExistingByEmail is owner-only (B2)', () => {
        it('allows the platform owner to enable linkExistingByEmail', async () => {
            const response = await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            expect(response.statusCode).toBe(StatusCodes.OK)
        })

        it('rejects a non-owner admin enabling linkExistingByEmail', async () => {
            const { mockUser } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.ADMIN },
            })
            const token = await generateMockToken({
                id: mockUser.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ linkExistingByEmail: true }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        async function tokenForNonOwnerAdmin(): Promise<string> {
            const { mockUser } = await mockBasicUser({
                user: { platformId: ctx.platform.id, platformRole: PlatformRole.ADMIN },
            })
            return generateMockToken({
                id: mockUser.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })
        }

        // The exact rule (round 2 of review): gated on the *merged* config's `linkExistingByEmail`,
        // not on whether this request's own body sets it — a non-owner admin must not be able to
        // repoint a connection-sensitive field on a config that already has linking-by-email on,
        // just because their own request never mentions that field.
        it('rejects a non-owner admin repointing the URL while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ url: 'ldaps://attacker.example.com:636' }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects a non-owner admin repointing attributeMap.email while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({
                    attributeMap: { subject: 'entryUUID', email: 'otherMail', firstName: 'givenName', lastName: 'sn' },
                }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('rejects a non-owner admin repointing userFilter while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ userFilter: '(sAMAccountName={username})' }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        // Round 3: the owner gate must also cover the two fields `configHasChanged` cannot see at
        // all — `bindPassword`/`caCertificate` live outside `LdapConfig` entirely.
        it('rejects a non-owner admin swapping the CA certificate while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ linkExistingByEmail: true, caCertificate: STATIC_TEST_CA_PEM }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        // Delta review: the CA-certificate case above doesn't prove `bindPassword` alone is covered
        // — a non-owner rotating only the bind password, with every `LdapConfig` field and the CA
        // certificate left untouched, must still be rejected.
        it('rejects a non-owner admin rotating only the bind password while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ linkExistingByEmail: true, bindPassword: 'a-different-bind-password' }),
            })
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        // A no-op resend is fine, even from a non-owner: nothing about the account-takeover flag
        // actually changes, so there is nothing for the owner-only gate to protect against here.
        it('allows a non-owner admin to resend the exact same config unchanged while linkExistingByEmail is already on', async () => {
            await ctx.post('/v1/platform-ldap-configs', validConfig({ linkExistingByEmail: true }))
            const token = await tokenForNonOwnerAdmin()
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/platform-ldap-configs',
                headers: { authorization: `Bearer ${token}` },
                payload: validConfig({ linkExistingByEmail: true, bindPassword: undefined }),
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
        })
    })
})

import { apId } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { beforeAll, describe, expect, it } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { encryptUtils } from '../../../../src/app/helper/encryption'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Opt-in only — this suite talks to a *real* LDAPS directory and is not run by
// `npm run test-api` / CI's "CE Integration Tests" job. Every other LDAP behavior (JIT
// provisioning, linking, collisions, error-code mapping) is covered against the real Postgres with
// a mocked `ldapClient` in `ldap-sign-in.test.ts`; this file exists only for the parts a mock
// cannot prove — the real `ldapts` wire protocol and real TLS certificate verification.
//
// Why opt-in rather than a CI service container: GitHub Actions `services:` containers (used here
// for postgres/redis in `.github/workflows/ci.yml`) run an image as-is with env vars and port
// mappings — they cannot run a setup script to generate a self-signed cert into the container
// first, and every off-the-shelf OpenLDAP image needs one to serve LDAPS. Standing that up
// properly means either a custom-built, registry-pushed image with a baked-in dev cert, or an
// extra "generate cert, copy into the running container's volume, restart slapd" step the
// `services:` block cannot express. Both are real, but out of scope for this PR.
//
// This file was written against the documented behavior of `bitnami/openldap` (LDAP_ENABLE_TLS
// auto-generates a self-signed cert when no cert/key is supplied) but could not be executed in
// the sandbox this PR was authored in: Docker Hub anonymous pulls were rate-limited (HTTP 429)
// for the whole session, on a shared daemon with other concurrent agent worktrees. Treat it as
// unvalidated until it has actually been run once. To run it locally:
//
//   docker run -d --name ldap-test -p 1389:1389 -p 1636:1636 \
//     -e LDAP_ENABLE_TLS=yes \
//     -e LDAP_ROOT=dc=example,dc=com \
//     -e LDAP_ADMIN_USERNAME=admin \
//     -e LDAP_ADMIN_PASSWORD=adminpassword \
//     -e LDAP_USERS=jdoe \
//     -e LDAP_PASSWORDS=correct-password \
//     bitnami/openldap:2.6
//   RUN_LDAP_OPENLDAP_TESTS=true npx vitest run test/integration/ce/ldap/ldap-openldap.test.ts
const RUN = process.env['RUN_LDAP_OPENLDAP_TESTS'] === 'true'

const LDAPS_URL = process.env['LDAP_TEST_LDAPS_URL'] ?? 'ldaps://127.0.0.1:1636'
const BIND_DN = process.env['LDAP_TEST_BIND_DN'] ?? 'cn=admin,dc=example,dc=com'
const BIND_PASSWORD = process.env['LDAP_TEST_BIND_PASSWORD'] ?? 'adminpassword'
const BASE_DN = process.env['LDAP_TEST_BASE_DN'] ?? 'dc=example,dc=com'
const TEST_USERNAME = process.env['LDAP_TEST_USERNAME'] ?? 'jdoe'
const TEST_PASSWORD = process.env['LDAP_TEST_PASSWORD'] ?? 'correct-password'

describe.skipIf(!RUN)('LDAP sign-in against a real OpenLDAP directory (opt-in)', () => {
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
    })

    async function saveConfig(overrides: Record<string, unknown> = {}): Promise<void> {
        await databaseConnection().getRepository('platform_ldap_config').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            platformId: ctx.platform.id,
            bindPassword: await encryptUtils.encryptObject(BIND_PASSWORD),
            caCertificate: null,
            config: {
                url: LDAPS_URL,
                tlsMode: 'ldaps',
                baseDn: BASE_DN,
                bindDn: BIND_DN,
                userFilter: '(uid={username})',
                attributeMap: {
                    subject: 'entryUUID',
                    email: 'mail',
                    firstName: 'givenName',
                    lastName: 'sn',
                },
                tlsVerify: false,
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

    it('signs in successfully against the real directory', async () => {
        await saveConfig()
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().token).toBeDefined()
    })

    it('rejects a wrong password', async () => {
        await saveConfig()
        const response = await signIn(TEST_USERNAME, 'the-wrong-password')
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('rejects an unknown username the same way as a wrong password', async () => {
        await saveConfig()
        const response = await signIn('no-such-user', 'irrelevant')
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('rejects a bad bind account', async () => {
        await saveConfig({ bindDn: 'cn=not-a-real-admin,dc=example,dc=com' })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_BIND_ACCOUNT_REJECTED')
    })

    it('reports the directory as unreachable when nothing listens on the configured host', async () => {
        await saveConfig({ url: 'ldaps://127.0.0.1:1' })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    // The self-signed cert `bitnami/openldap` generates is never in any trust store, so this
    // just needs `tlsVerify: true` (the platform-admin default) against the same directory the
    // other cases in this file already reach with `tlsVerify: false`.
    it('refuses a self-signed certificate when tlsVerify is on', async () => {
        await saveConfig({ tlsVerify: true })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })
})

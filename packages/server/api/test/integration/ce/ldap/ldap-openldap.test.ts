import tls from 'node:tls'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Opt-in only, but exercised in CI: the "CE integration suite" job in `.github/workflows/ci.yml`
// runs this file too (via a dedicated `run:` step that stands up the same container this header
// documents, then sets `RUN_LDAP_OPENLDAP_TESTS=true`), so it is not "run locally only" the way an
// opt-in suite normally is — the env-gate stays because the test-ce path (`npm run test-api`) has
// no service-container equivalent for a directory that needs a fresh cert installed before slapd
// starts (see below), so a local `test-ce` run still needs this opted in explicitly. Every other
// LDAP behavior (JIT provisioning, linking, collisions, error-code mapping) is covered against the
// real Postgres with a mocked `ldapClient` in `ldap-sign-in.test.ts`; this file exists only for
// the parts a mock cannot prove — the real `ldapts` wire protocol and real TLS certificate
// verification. Config is written through `POST /v1/platform-ldap-configs` (the real `upsert`
// path, including its own bind-password/CA-certificate encryption), never by writing the entity
// row directly — the encryption-mismatch bug below was only catchable because a real `upsert` call
// was in the loop.
//
// VALIDATED — run against a real directory, all 8 cases below passed, both locally (isolated
// containers) and via the CI step. That local run is also what caught a real bug:
// `ldapConfigService.upsert` encrypted `bindPassword`/`caCertificate` with `encryptObject` (which
// JSON-stringifies before encrypting — meant for object-shaped secrets, e.g. `ai-provider`'s
// `auth`), while `getResolvedForSignIn`/`test` decrypted with `decryptString` (no JSON.parse) — a
// mismatched pair that silently produced a bind password with literal escaped quotes around it
// (`"GoodNewsEveryone"` instead of `GoodNewsEveryone`), which every mocked test in this repo was
// structurally unable to catch, since none of them ever decrypt a value and hand it to a real
// bind. Fixed by using `encryptString`/`decryptString` consistently for both plain-string secrets.
// Uses `ghcr.io/ldapjs/docker-test-openldap` (the ldapjs project's own test fixture: base
// `dc=planetexpress,dc=com`, admin `cn=admin,dc=planetexpress,dc=com` / `GoodNewsEveryone`, users
// like `cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com` / `uid: fry`). Two things about the
// image needed working around, both folded into the commands below and into the CI step:
//   1. Its baked-in TLS cert (`/etc/ldap/ssl/ldap.crt`) expired 2024-10-29 — Node's TLS stack
//      rejects an expired cert even with the right CA trusted, so the "success once the CA is
//      supplied" case is unprovable against the original cert. A fresh 10-year self-signed cert
//      with a matching `IP:127.0.0.1` SAN is bind-mounted in over it (the run.sh entrypoint does
//      `chown -R openldap:openldap /etc/ldap` before starting slapd, so the mount must be
//      read-write, not `:ro`, or that chown fails and slapd never starts).
//   2. `fry`'s seeded password is an `{ssha}` hash with no documented plaintext anywhere in the
//      image or upstream project — reset via `ldappasswd` as the admin after the container starts,
//      to a value this suite controls.
//
//   mkdir -p /tmp/ldap-test-certs && cd /tmp/ldap-test-certs
//   openssl req -x509 -newkey rsa:2048 -keyout ldap.key -out ldap.crt -days 3650 -nodes \
//     -subj "/CN=planetexpress.com" \
//     -addext "subjectAltName=DNS:planetexpress.com,DNS:localhost,IP:127.0.0.1"
//   docker run -d --name ldap-openldap-test-339 -p 23890:389 -p 23891:636 \
//     -v /tmp/ldap-test-certs/ldap.crt:/etc/ldap/ssl/ldap.crt \
//     -v /tmp/ldap-test-certs/ldap.key:/etc/ldap/ssl/ldap.key \
//     ghcr.io/ldapjs/docker-test-openldap/openldap@sha256:2a8ad09a52aa5aa151d6286c383ac3454a0dc0170d6594656dc5710156fc821b
//   for i in $(seq 1 30); do nc -z 127.0.0.1 23891 && break; sleep 1; done
//   docker exec ldap-openldap-test-339 ldappasswd -x -H ldap://localhost \
//     -D "cn=admin,dc=planetexpress,dc=com" -w GoodNewsEveryone \
//     -s "correct-horse-battery-staple" "cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com"
//   RUN_LDAP_OPENLDAP_TESTS=true npx vitest run test/integration/ce/ldap/ldap-openldap.test.ts
//   docker rm -f ldap-openldap-test-339   # afterwards
const RUN = process.env['RUN_LDAP_OPENLDAP_TESTS'] === 'true'

const LDAP_HOST = process.env['LDAP_TEST_HOST'] ?? '127.0.0.1'
const LDAPS_PORT = Number(process.env['LDAP_TEST_LDAPS_PORT'] ?? 23891)
const LDAP_PORT = Number(process.env['LDAP_TEST_LDAP_PORT'] ?? 23890)
const BIND_DN = process.env['LDAP_TEST_BIND_DN'] ?? 'cn=admin,dc=planetexpress,dc=com'
const BIND_PASSWORD = process.env['LDAP_TEST_BIND_PASSWORD'] ?? 'GoodNewsEveryone'
const BASE_DN = process.env['LDAP_TEST_BASE_DN'] ?? 'dc=planetexpress,dc=com'
const TEST_USERNAME = process.env['LDAP_TEST_USERNAME'] ?? 'fry'
const TEST_PASSWORD = process.env['LDAP_TEST_PASSWORD'] ?? 'correct-horse-battery-staple'

// The directory in this suite listens on loopback, which the LDAP host guard blocks by default —
// deliberately, the same as any other private/loopback address. Allow-listing it here is the
// equivalent of an operator's own `AP_LDAP_ALLOW_LIST` entry for their real, non-loopback
// directory. Only set when the suite actually runs, so a skipped import never mutates the
// process env other test files in the same run might rely on.
if (RUN) {
    process.env['AP_LDAP_ALLOW_LIST'] = LDAP_HOST
}

describe.skipIf(!RUN)('LDAP sign-in against a real OpenLDAP directory (opt-in)', () => {
    let app: FastifyInstance | null = null
    let ctx: TestContext
    let serverCertificatePem: string

    beforeAll(async () => {
        app = await setupTestEnvironment()
        serverCertificatePem = await fetchPeerCertificatePem({ host: LDAP_HOST, port: LDAPS_PORT })
    })

    afterAll(async () => {
        await teardownTestEnvironment()
    })

    beforeEach(async () => {
        await cleanDatabase()
        ctx = await createTestContext(app!)
    })

    // Goes through the real `POST /v1/platform-ldap-configs` `upsert` handler — including its own
    // bind-password/CA-certificate encryption — rather than writing the entity row directly. That
    // real `upsert` call in the loop is exactly what let this suite catch the encryption-mismatch
    // bug documented above; a direct row write would have bypassed the buggy code path entirely.
    async function saveConfig(overrides: Record<string, unknown> = {}, caCertificatePem?: string): Promise<void> {
        const response = await ctx.post('/v1/platform-ldap-configs', {
            url: `ldaps://${LDAP_HOST}:${LDAPS_PORT}`,
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
            bindPassword: BIND_PASSWORD,
            tlsVerify: false,
            jitProvisioning: true,
            linkExistingByEmail: false,
            sessionTtlSeconds: 43200,
            enabled: true,
            ...(caCertificatePem ? { caCertificate: caCertificatePem } : {}),
            ...overrides,
        })
        if (response.statusCode !== StatusCodes.OK) {
            throw new Error(`upsert failed while preparing the test fixture: ${response.statusCode} ${response.body}`)
        }
        if (caCertificatePem) {
            // The CA-certificate round trip M5 asks this suite to exercise: `upsert` reports
            // `hasCaCertificate` without ever echoing the certificate itself back over HTTP, and
            // `succeeds with tlsVerify on once the matching CA certificate is supplied` below
            // proves the *decrypted* value it stored is still the one that verifies this exact
            // server's real certificate.
            expect(response.json().hasCaCertificate).toBe(true)
        }
    }

    async function signIn(username: string, password: string) {
        return app!.inject({
            method: 'POST',
            url: '/api/v1/authn/ldap/sign-in',
            body: { username, password },
        })
    }

    it('JIT-provisions and signs in successfully over LDAPS', async () => {
        await saveConfig()
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.token).toBeDefined()
        expect(body.email).toBe('fry@planetexpress.com')
    })

    it('signs in successfully over StartTLS', async () => {
        await saveConfig({
            url: `ldap://${LDAP_HOST}:${LDAP_PORT}`,
            tlsMode: 'starttls',
        })
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
        await saveConfig({ bindDn: 'cn=not-a-real-admin,dc=planetexpress,dc=com' })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_BIND_ACCOUNT_REJECTED')
    })

    it('reports the directory as unreachable when nothing listens on the configured host', async () => {
        await saveConfig({ url: `ldaps://${LDAP_HOST}:1` })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    // `tlsVerify: true` with no CA supplied means Node validates against the system trust store,
    // which never contains a directory's own self-signed cert.
    it('refuses the self-signed certificate when tlsVerify is on and no CA is configured', async () => {
        await saveConfig({ tlsVerify: true })
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    it('succeeds with tlsVerify on once the matching CA certificate is supplied', async () => {
        await saveConfig({ tlsVerify: true }, serverCertificatePem)
        const response = await signIn(TEST_USERNAME, TEST_PASSWORD)
        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().token).toBeDefined()
    })
})

function fetchPeerCertificatePem({ host, port }: { host: string, port: number }): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
            const cert = socket.getPeerCertificate(false)
            socket.end()
            if (!cert?.raw) {
                reject(new Error(`No peer certificate received from ${host}:${port}`))
                return
            }
            const base64Lines = cert.raw.toString('base64').match(/.{1,64}/g) ?? []
            resolve(`-----BEGIN CERTIFICATE-----\n${base64Lines.join('\n')}\n-----END CERTIFICATE-----\n`)
        })
        socket.once('error', reject)
    })
}

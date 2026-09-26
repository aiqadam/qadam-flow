import tls from 'node:tls'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Client } from 'ldapts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Opt-in only, but exercised in CI: the "CE integration suite" job in `.github/workflows/ci.yml`
// runs this file too (via a dedicated `run:` step that stands up the same container this header
// documents, then sets `QF_RUN_LDAP_OPENLDAP_TESTS=true`), so it is not "run locally only" the way
// an opt-in suite normally is. The flag is `QF_`-prefixed, not a bare name, because turbo's
// `globalPassThroughEnv` (`turbo.json`) only forwards `AP_*`/`QF_*` to the spawned `vitest`
// process under its strict env mode — a bare `RUN_LDAP_OPENLDAP_TESTS` was silently stripped,
// which made every one of this suite's 8 cases skip in CI without ever failing the job (round 2 of
// #339's review). `QF_` is the canonical (and only) prefix (#339 Phase 2 round 3) — the
// `AP_RUN_LDAP_OPENLDAP_TESTS` fallback this file used to also read was dropped: it duplicated the
// same env-migration coverage every other `AP_*`/`QF_*` prop gets through `system.get()`, but this
// one file bypassed that mirror by reading `process.env` directly, so the fallback here was its own
// small, one-off maintenance burden rather than shared infrastructure. The `describe.skipIf(!RUN)`
// below stays a *skip* for a genuinely local,
// opted-out run, but `if (!RUN && IS_CI)` turns the same missing flag into a hard failure whenever
// `CI=true`, so a future regression in the env plumbing fails loudly instead of quietly reporting
// 8 skipped as green. The env-gate itself stays because the test-ce path (`npm run test-api`) has
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
// Run against a real directory, all 8 cases below passed, on isolated local containers. That run
// is also what caught a real bug:
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
//   for i in $(seq 1 30); do
//     docker exec ldap-openldap-test-339 ldapwhoami -x -H ldap://localhost \
//       -D "cn=admin,dc=planetexpress,dc=com" -w GoodNewsEveryone >/dev/null 2>&1 && break
//     sleep 1
//   done
//   docker exec ldap-openldap-test-339 ldappasswd -x -H ldap://localhost \
//     -D "cn=admin,dc=planetexpress,dc=com" -w GoodNewsEveryone \
//     -s "correct-horse-battery-staple" "cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com"
//   QF_RUN_LDAP_OPENLDAP_TESTS=true npx vitest run test/integration/ce/ldap/ldap-openldap.test.ts
//   docker rm -f ldap-openldap-test-339   # afterwards
const RUN = process.env['QF_RUN_LDAP_OPENLDAP_TESTS'] === 'true'
const IS_CI = process.env['CI'] === 'true'

const LDAP_HOST = process.env['LDAP_TEST_HOST'] ?? '127.0.0.1'
const LDAPS_PORT = Number(process.env['LDAP_TEST_LDAPS_PORT'] ?? 23891)
const LDAP_PORT = Number(process.env['LDAP_TEST_LDAP_PORT'] ?? 23890)
const BIND_DN = process.env['LDAP_TEST_BIND_DN'] ?? 'cn=admin,dc=planetexpress,dc=com'
const BIND_PASSWORD = process.env['LDAP_TEST_BIND_PASSWORD'] ?? 'GoodNewsEveryone'
const BASE_DN = process.env['LDAP_TEST_BASE_DN'] ?? 'dc=planetexpress,dc=com'
const TEST_USERNAME = process.env['LDAP_TEST_USERNAME'] ?? 'fry'
const TEST_PASSWORD = process.env['LDAP_TEST_PASSWORD'] ?? 'correct-horse-battery-staple'
const TEST_USER_DN = process.env['LDAP_TEST_USER_DN'] ?? 'cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'

// Round 3 (app-sec finding #3): the group-mapping case below used to configure
// `groupSearchBaseDn`/`groupSearchFilter` without ever setting `nestedGroups: true` — the one flag
// `resolveMemberGroupDns` actually gates the nested-group search on (`ldap-client.ts`) — so the
// search never ran at all. The assertion still passed, but for the wrong reason: this fixture's
// `memberof` overlay (confirmed live against the real container — adding *any* new `Group`/`member`
// entry immediately grows a matching `memberOf` back-link on the member) already puts
// `cn=ship_crew,...` directly on the signed-in user's own entry, so the *direct*-`memberOf` half of
// `resolveMemberGroupDns` alone was resolving the mapped group, independent of whether the search
// ran. This fixture group is the deterministic fix: `groupOfUniqueNames`/`uniqueMember` is not a
// `member`-attribute the overlay watches (verified empirically: adding one does not grow the
// member's `memberOf`), so a mapping resolved via this group can only ever match through the
// configured `(uniqueMember={userDn})` nested search itself — proving the search, not `memberOf`,
// is what grants the role.
const GROUP_SEARCH_ONLY_GROUP_DN = 'cn=qa_crew_search_only,ou=people,dc=planetexpress,dc=com'

// The directory in this suite listens on loopback, which the LDAP host guard blocks by default —
// deliberately, the same as any other private/loopback address. Allow-listing it here is the
// equivalent of an operator's own `AP_LDAP_ALLOW_LIST` entry for their real, non-loopback
// directory. Only set when the suite actually runs, so a skipped import never mutates the
// process env other test files in the same run might rely on.
if (RUN) {
    process.env['AP_LDAP_ALLOW_LIST'] = LDAP_HOST
}

if (!RUN && IS_CI) {
    describe('LDAP sign-in against a real OpenLDAP directory — CI must not silently skip this suite', () => {
        it('fails instead of skipping when QF_RUN_LDAP_OPENLDAP_TESTS was not propagated to CI', () => {
            throw new Error('QF_RUN_LDAP_OPENLDAP_TESTS was not \'true\' in CI. This suite\'s 8 real-directory '
                + 'cases would otherwise silently report as skipped rather than failing the job — see the M5 '
                + 'step in .github/workflows/ci.yml and this file\'s own header.')
        })
    })
}

describe.skipIf(!RUN)('LDAP sign-in against a real OpenLDAP directory (opt-in)', () => {
    let app: FastifyInstance | null = null
    let ctx: TestContext
    let serverCertificatePem: string

    beforeAll(async () => {
        app = await setupTestEnvironment()
        serverCertificatePem = await fetchPeerCertificatePem({ host: LDAP_HOST, port: LDAPS_PORT })
        await addSearchOnlyGroupFixture()
    })

    afterAll(async () => {
        await removeSearchOnlyGroupFixture()
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
    async function saveConfig({ overrides = {}, caCertificatePem }: SaveConfigParams = {}): Promise<void> {
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

    async function signIn({ username, password }: SignInParams) {
        return app!.inject({
            method: 'POST',
            url: '/api/v1/authn/ldap/sign-in',
            body: { username, password },
        })
    }

    it('JIT-provisions and signs in successfully over LDAPS', async () => {
        await saveConfig()
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.statusCode).toBe(StatusCodes.OK)
        const body = response.json()
        expect(body.token).toBeDefined()
        expect(body.email).toBe('fry@planetexpress.com')
    })

    it('signs in successfully over StartTLS', async () => {
        await saveConfig({
            overrides: {
                url: `ldap://${LDAP_HOST}:${LDAP_PORT}`,
                tlsMode: 'starttls',
            },
        })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().token).toBeDefined()
    })

    it('rejects a wrong password', async () => {
        await saveConfig()
        const response = await signIn({ username: TEST_USERNAME, password: 'the-wrong-password' })
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('rejects an unknown username the same way as a wrong password', async () => {
        await saveConfig()
        const response = await signIn({ username: 'no-such-user', password: 'irrelevant' })
        expect(response.json().code).toBe('INVALID_CREDENTIALS')
    })

    it('rejects a bad bind account', async () => {
        await saveConfig({ overrides: { bindDn: 'cn=not-a-real-admin,dc=planetexpress,dc=com' } })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.json().code).toBe('LDAP_BIND_ACCOUNT_REJECTED')
    })

    it('reports the directory as unreachable when nothing listens on the configured host', async () => {
        await saveConfig({ overrides: { url: `ldaps://${LDAP_HOST}:1` } })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    // `tlsVerify: true` with no CA supplied means Node validates against the system trust store,
    // which never contains a directory's own self-signed cert.
    it('refuses the self-signed certificate when tlsVerify is on and no CA is configured', async () => {
        await saveConfig({ overrides: { tlsVerify: true } })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.json().code).toBe('LDAP_DIRECTORY_UNREACHABLE')
    })

    it('succeeds with tlsVerify on once the matching CA certificate is supplied', async () => {
        await saveConfig({ overrides: { tlsVerify: true }, caCertificatePem: serverCertificatePem })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.json().token).toBeDefined()
    })

    // Phase 2 (#339), round 3: the fixture image's `memberof` overlay is live (confirmed by
    // directly probing the running container — adding a `Group`/`member` entry immediately grows a
    // matching `memberOf` back-link on the member), so a mapping keyed on a real `Group` the signed-
    // in user already belongs to would be granted by the plain direct-`memberOf` half of
    // `resolveMemberGroupDns` alone, regardless of whether `nestedGroups`/the configured search ran
    // at all — `addSearchOnlyGroupFixture` seeds a `groupOfUniqueNames` entry specifically because
    // the overlay does not watch `uniqueMember`, so a mapping resolved via *that* group can only
    // ever match through the search this test configures, never through `memberOf`. The filter uses
    // plain equality (`uniqueMember={userDn})`), not AD's `LDAP_MATCHING_RULE_IN_CHAIN` OID — slapd's
    // default backend does not implement that Microsoft-specific extensible-match control, so the
    // nested-group (transitive membership) case is unprovable against this OpenLDAP fixture and is
    // covered only by the mocked unit/integration tests instead.
    it('applies a group mapping resolved via a real nested-group search, granting the mapped platform role', async () => {
        await saveConfig({
            overrides: {
                nestedGroups: true,
                groupSearchBaseDn: BASE_DN,
                groupSearchFilter: '(uniqueMember={userDn})',
                groupMappings: [{ groupDn: GROUP_SEARCH_ONLY_GROUP_DN, platformRole: 'OPERATOR', projects: [] }],
            },
        })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.statusCode).toBe(StatusCodes.OK)

        const identity = await databaseConnection().getRepository('user_identity').findOneByOrFail({ email: 'fry@planetexpress.com' })
        const user = await databaseConnection().getRepository('user').findOneBy({ platformId: ctx.platform.id, identityId: identity.id })
        expect(user?.platformRole).toBe('OPERATOR')
    })

    // The negative case that makes the positive one above provable: with `nestedGroups` left off,
    // `resolveMemberGroupDns` never runs the configured search at all (`ldap-client.ts`) — since the
    // mapped group is only reachable through that search (never through `memberOf`, per the fixture
    // comment above), the mapping must not apply and the JIT-provisioned user must be the default
    // MEMBER, not OPERATOR.
    it('does NOT apply that same mapping when nestedGroups is off, since only the search resolves it', async () => {
        await saveConfig({
            overrides: {
                nestedGroups: false,
                groupSearchBaseDn: BASE_DN,
                groupSearchFilter: '(uniqueMember={userDn})',
                groupMappings: [{ groupDn: GROUP_SEARCH_ONLY_GROUP_DN, platformRole: 'OPERATOR', projects: [] }],
            },
        })
        const response = await signIn({ username: TEST_USERNAME, password: TEST_PASSWORD })
        expect(response.statusCode).toBe(StatusCodes.OK)

        const identity = await databaseConnection().getRepository('user_identity').findOneByOrFail({ email: 'fry@planetexpress.com' })
        const user = await databaseConnection().getRepository('user').findOneBy({ platformId: ctx.platform.id, identityId: identity.id })
        expect(user?.platformRole).toBe('MEMBER')
    })
})

// Seeds (and, on teardown, removes) the `groupOfUniqueNames` fixture the group-search-only test
// depends on — plain `ldap://`, admin-bound, entirely separate from the app's own `ldapClient`
// under test. `add` failing with "already exists" (a re-run against a container that already has
// it) and `del` failing with "no such object" (nothing to remove) are both swallowed; any other
// failure is real and should fail the suite loudly rather than silently leaving stale/missing
// fixture state for the next run.
async function addSearchOnlyGroupFixture(): Promise<void> {
    const client = new Client({ url: `ldap://${LDAP_HOST}:${LDAP_PORT}` })
    try {
        await client.bind(BIND_DN, BIND_PASSWORD)
        await client.add(GROUP_SEARCH_ONLY_GROUP_DN, {
            objectClass: 'groupOfUniqueNames',
            cn: 'qa_crew_search_only',
            uniqueMember: TEST_USER_DN,
        })
    }
    catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Entry Already Exists')) {
            throw error
        }
    }
    finally {
        await client.unbind().catch(() => undefined)
    }
}

async function removeSearchOnlyGroupFixture(): Promise<void> {
    const client = new Client({ url: `ldap://${LDAP_HOST}:${LDAP_PORT}` })
    try {
        await client.bind(BIND_DN, BIND_PASSWORD)
        await client.del(GROUP_SEARCH_ONLY_GROUP_DN)
    }
    catch (error) {
        if (!(error instanceof Error) || !error.message.includes('No Such Object')) {
            throw error
        }
    }
    finally {
        await client.unbind().catch(() => undefined)
    }
}

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

type SaveConfigParams = {
    overrides?: Record<string, unknown>
    caCertificatePem?: string
}

type SignInParams = {
    username: string
    password: string
}

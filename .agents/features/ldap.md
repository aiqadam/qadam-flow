# LDAP / Active Directory Sign-In (Phase 1)

## Summary
Per-platform LDAP/AD directory sign-in, additive to local password auth. A platform admin
configures one `platform_ldap_config` row per platform (bind account, base DN, user filter,
attribute map, TLS mode). End users sign in with their directory username/password at
`POST /v1/authn/ldap/sign-in`; the server binds to the directory as the service account, searches
for exactly one matching entry, then re-binds as that user on a fresh connection to verify the
password. A directory subject (`objectGUID`/`entryUUID`) is mapped to a platform user via a
generic `user_federated_identity` join table, separate from `UserIdentity` and from `user
.externalId`. Clean-room implementation from RFC 4511/4513/4515 behavior — no upstream EE source
was read or copied (`.agents/rules/edition-safety.md`).

## Key Files
- `packages/server/api/src/app/authentication/ldap/ldap-config-entity.ts` — `platform_ldap_config` TypeORM entity (plaintext config json + `EncryptedObject` bind password / CA cert)
- `packages/server/api/src/app/authentication/ldap/ldap-config-service.ts` — CRUD (no network I/O on save), `/test` orchestration, `getResolvedForSignIn` (decrypted config for the sign-in flow only, never returned over HTTP)
- `packages/server/api/src/app/authentication/ldap/ldap-config-controller.ts` / `ldap-config-module.ts` — platform-admin routes at `/v1/platform-ldap-configs`
- `packages/server/api/src/app/authentication/ldap/ldap-host-guard.ts` — resolves every A/AAAA record for the configured host via `dns.lookup(host, { all: true })` (the OS resolver — honours `/etc/hosts`/Docker `extra_hosts`, unlike `resolve4`/`resolve6`) and vets each IP with `ssrfIpClassifier.isBlockedIp` (`@aiqadam/shared`) against the `AP_LDAP_ALLOW_LIST` allow list (parsed via `safeHttp.parseAllowList`, shared with the SSRF filter's own parser); an IP literal skips DNS entirely; an `::ffff:`-mapped IPv4 metadata address is unwrapped before the metadata-address comparison
- `packages/server/api/src/app/authentication/ldap/ldap-client.ts` — thin wrapper over `ldapts`: connects to the first vetted IP (capped at 4 per attempt), TLS `servername` explicitly set to the *hostname*, never the dialed IP — see below; service bind, search, user bind on a **new** connection, unbind; a process-wide concurrency cap (slot held for a connection's *entire* lifetime, not just its connect step) with a bounded wait queue and per-wait timeout, a StartTLS handshake timeout, and a guard against `ldapts` silently reconnecting a dropped StartTLS session in plaintext — see "Connection lifecycle & concurrency (M1)" below
- `packages/server/api/src/app/authentication/ldap/ldap-filter.ts` — RFC 4515 filter-value escaping (`\`, `*`, `(`, `)`, NUL)
- `packages/server/api/src/app/authentication/ldap/ldap-username.ts` — `ldapUsernameUtils.normalize`: trim, collapse whitespace, NFKC, lowercase — the one normalisation both the rate limiter and the directory search use, so they can never disagree about "the same username"
- `packages/server/api/src/app/authentication/ldap/ldap-attributes.ts` — attribute readers (case-insensitive key lookup — the directory's own casing convention, not the admin's typing, decides how a name comes back) + AD `objectGUID` buffer → canonical mixed-endian GUID string conversion
- `packages/server/api/src/app/authentication/ldap/ldap-stage-error.ts` — internal error carrying the failing stage + LDAP result code, shared by the sign-in error mapping and the `/test` response
- `packages/server/api/src/app/authentication/ldap/ldap-sign-in-rate-limit.ts` — the per-username (regardless of source IP) dimension of sign-in rate limiting
- `packages/server/api/src/app/authentication/ldap/ldap-authn-service.ts` — sign-in orchestration: lookup order, JIT provisioning, link-by-email, token minting
- `packages/server/api/src/app/authentication/ldap/ldap-authn-controller.ts` / `ldap-authn-module.ts` — `POST /v1/authn/ldap/sign-in`
- `packages/server/api/src/app/authentication/federated-identity/user-federated-identity-entity.ts` / `-service.ts` — `user_federated_identity` table + repo
- `packages/shared/src/lib/core/authentication/ldap/ldap-config.ts` — `LdapConfig`, `UpsertLdapConfigRequest`, `PlatformLdapConfig`, `LdapTestRequest`/`Response`, `LdapTestStage`
- `packages/shared/src/lib/core/authentication/ldap/ldap-sign-in-request.ts` — `LdapSignInRequest`
- `packages/shared/src/lib/core/authentication/federated-identity.ts` — `FederatedIdentityProvider`, `UserFederatedIdentity`
- Guards added to existing files: `user-identity-service.ts` (`verifyIdentityPassword`, `updatePassword`, new `linkToFederatedProvider`), `otp-service.ts` (`createAndSend` for `PASSWORD_RESET`), `authentication-utils.ts` (`getProjectAndToken` gained an optional `expiresInSeconds`), `flag.service.ts` (`ApFlagId.LDAP_AUTH_ENABLED`), `authentication.service.ts` (`switchPlatform`'s `getUserForPlatform` refuses an LDAP identity's `user` row with no federated row on the target platform), `user-invitation.service.ts` (`provisionUserInvitation` refuses to grant a new platform to an LDAP identity with no federated row there — see "Reverse-direction identity squatting guards" below)

## Domain Terms
- **`platform_ldap_config`** — one row per platform (unique `platformId`); plaintext operational config in `config` json, secrets (`bindPassword`, optional `caCertificate`) as `EncryptedObject`
- **`user_federated_identity`** — generic external-identity join: `(platformId, provider, subject)` unique and `(platformId, userId, provider)` unique; `provider` is `FederatedIdentityProvider` (`LDAP` now, meant to be reused by a future OIDC `sub`); rows survive deleting the LDAP config
- **subject** — the directory's own stable identifier for the entry, restricted to `LdapSubjectAttribute` (`objectGUID` canonical mixed-endian string form, or OpenLDAP `entryUUID`) — not an operator-chosen custom attribute: a mutable attribute like `uid`/`mail` here would let whoever controls the directory repoint an account to a different real person by editing that attribute, with no admin-side re-link step to notice it
- **Host guard** — `AP_LDAP_ALLOW_LIST`, resolved/classified independently of `AP_SSRF_ALLOW_LIST` so approving the directory does not also open its subnet to outbound-HTTP qadams
- **Stage** — `LdapTestStage` (`NOT_CONFIGURED`/`ALLOW_LIST`/`CONNECT`/`SERVICE_BIND`/`SEARCH`/`USER_BIND`/`SUCCESS`), the unit the admin-only `/test` endpoint and internal error mapping both key on

## Entities

### `platform_ldap_config`
| Column | Type | Notes |
|---|---|---|
| platformId | string | unique FK → `platform`, `ON DELETE CASCADE` |
| config | json | `LdapConfig`: url, tlsMode (`ldaps`\|`starttls`), baseDn, bindDn, userFilter, attributeMap, tlsVerify, jitProvisioning, linkExistingByEmail, sessionTtlSeconds (3600–604800, default 43200), enabled |
| bindPassword | `EncryptedObject` (json) | required; re-supply is mandatory whenever `url`, `bindDn`, `tlsVerify`, `tlsMode` or `caCertificate` changes on an update — otherwise the old bind credentials would silently start being sent to a newly-repointed host |
| caCertificate | `EncryptedObject` (json), nullable | PEM validated with `crypto.X509Certificate` at save |

### `user_federated_identity`
| Column | Type | Notes |
|---|---|---|
| platformId | string | not a FK to `platform_ldap_config` — independent of config lifecycle |
| userId | string | FK → `user`, `ON DELETE CASCADE` |
| provider | string | `FederatedIdentityProvider` |
| subject | string | directory-native identifier, canonicalized |

## Endpoints

| Method | Path | Security | Description |
|---|---|---|---|
| GET | `/v1/platform-ldap-configs` | platformAdminOnly (USER) | Returns `hasBindPassword`/`hasCaCertificate`, never the secrets themselves |
| POST | `/v1/platform-ldap-configs` | platformAdminOnly (USER) | Upsert; an omitted secret field keeps the stored value; zod validation only, no network I/O |
| DELETE | `/v1/platform-ldap-configs` | platformAdminOnly (USER) | Deletes the platform's config (does not touch `user_federated_identity` rows) |
| POST | `/v1/platform-ldap-configs/test` | platformAdminOnly (USER) | Connects through the host guard; optional test username/password exercises the full bind+search+user-bind path, including verifying the email/subject attributes actually resolve on the matched entry; returns the failing `stage` + LDAP result code. Response schema is `LdapTestResponse`. |
| POST | `/v1/authn/ldap/sign-in` | public, rate-limited (IP + IP:username + username) | `{ username, password }`; empty password refused before any I/O |

## Service Methods

### `ldapConfigService`
- `get`/`upsert`/`delete` — no network I/O; `upsert` re-validates the merged config with `LdapConfig.parse` so a partial update can't leave an invalid row
- `getResolvedForSignIn` — the only other reader of the decrypted secrets besides `test`; never exposed over HTTP
- `test` — full connect → service bind → (optional) search + attribute-resolvability check → user bind, returning `LdapTestResponse`; "no config saved" is its own `NOT_CONFIGURED` stage, distinct from an `ALLOW_LIST` failure

### `ldapAuthnService.signIn`
1. Refuse an empty password before any lookup (defense in depth; the zod schema already refuses it at the HTTP boundary)
2. Load the platform's resolved config; refuse if absent or disabled (`LDAP_DIRECTORY_UNREACHABLE`)
3. Service bind → RFC 4515-escaped search on the **normalised** username (`ldapUsernameUtils.normalize`: trim, collapse whitespace, NFKC, lowercase — the same normalisation the rate limiter keys on, so the two can never disagree about "the same username"; `sizeLimit: 2`, exactly one entry required) → user bind on a **new** connection → read attributes → unbind
4. Resolve the platform user, in order:
   - `user_federated_identity` lookup by `(platformId, LDAP, subject)` → existing user (INACTIVE refused, never reactivated). This is the only unguarded path — everything below runs `assertIdentityIsNotPrivilegedElsewhere` first.
   - else `UserIdentity` lookup by email (case-insensitive). Before doing anything with it, `assertIdentityIsNotPrivilegedElsewhere` refuses (`LDAP_ACCOUNT_COLLISION`, indistinguishable from a plain collision) whenever the identity has a user on any *other* platform, or holds `platformRole: ADMIN` on any platform, or *is* the platform owner anywhere — **the owner's break-glass**: no directory, however configured, can ever link or adopt the owner, so their local password always keeps working. Past that gate:
     - identity already `provider === LDAP` (no federated row for *this* platform — deleted user or half-finished JIT, both scoped to `platformId` itself) → recover: `getOrCreateWithProject`, then create the federated row if absent, or refuse (`LDAP_ACCOUNT_COLLISION`) if one exists with a *different* subject — a deliberate refusal, not a re-point, since silently repointing would hand a rotated directory entry someone else's account. Never a route onto a *different* platform: `assertIdentityIsNotPrivilegedElsewhere`, just above, already refuses any identity with a user row on another platform, so a "first sign-in on a second platform" is a collision here, not a recovery. No password scramble on this path; there is no local password to protect.
     - else `linkExistingByEmail` off → `LDAP_ACCOUNT_COLLISION`; on → link (flip provider to `LDAP`, scramble password, rotate `tokenVersion`, create the federated row)
   - else, `jitProvisioning` on → `userIdentityService.create` (verified, random password, provider `LDAP`) + `userService.getOrCreateWithProject` (MEMBER + personal project); off → `INVALID_CREDENTIALS` (anti-enumeration)
   - Every branch below the fast subject-match one runs inside one DB transaction (`transaction()` in `core/db/transaction.ts`) — identity, user/project and federated row are created/linked atomically, so a mid-way failure leaves nothing half-created (in particular, never an identity with no federated row, which would be a permanently unreachable account: local password sign-in also refuses `provider === LDAP`).
5. Mint a token via `accessTokenManager.generateToken(principal, config.sessionTtlSeconds)` and emit `USER_SIGNED_IN`

### `linkExistingByEmail` is owner-only
`ldapConfigService.upsert` rejects (`AUTHORIZATION`, 403) any change to a config whose *merged*
`linkExistingByEmail` is `true`, unless the caller is the platform's own owner (`platform.ownerId`)
— gated on the merged value, not on whether this request's own body sets the field, so a non-owner
admin can't dodge the check by repointing `url`/`attributeMap.email`/`userFilter` etc. on a config
that already has linking-by-email on without ever mentioning that field. A caller may still resend
the exact same config unchanged (a no-op, compared field-for-field against the stored config) even
if not the owner; turning the flag back off, or never turning it on, is unrestricted.

Fixing this surfaced a deeper, previously-undiscovered bug in `UpsertLdapConfigRequest`
(`packages/shared`): `.partial()` layered over a field that already carries its own `.default(...)`
(`tlsVerify`, `jitProvisioning`, `linkExistingByEmail`, `sessionTtlSeconds`, `enabled`) does not
defeat that default in this zod version — an *omitted* field on a partial update was silently
parsing to the schema's default value, not `undefined`, contradicting `upsert`'s own "an omitted
field on update keeps the stored value" design and resetting all five fields to their base
defaults on *any* update that didn't explicitly resend them. Fixed by redefining all five with a
plain `.optional()` (no `.default()`) directly on `UpsertLdapConfigRequest`, overriding the
inherited default-carrying field via `.extend(...)`.

### `/switch-platform` and the LDAP session TTL
Reissuing a token on `/switch-platform` used to reset the clock to the default 7-day TTL,
silently undoing a directory admin's own `sessionTtlSeconds` every time an LDAP-signed-in user
switched platforms. For an LDAP identity, the reissued token is capped at the *current* token's
own remaining `exp` (never extended by switching to a platform with a longer configured TTL) —
`authentication.controller.ts` decodes (not re-verifies; the request already passed auth
middleware) the incoming JWT's `exp` and threads it to `authentication.service.ts`, which applies
the cap only when `identity.provider === LDAP`. Every other identity provider is unaffected.

### Bind password re-supply on connection-sensitive changes
`ldapConfigService.upsert` rejects an update that changes `url`, `bindDn`, `tlsVerify`,
`tlsMode` or `caCertificate` without also re-supplying `bindPassword` — otherwise a stored bind
password could be exfiltrated by repointing the connection at an attacker-controlled host and
letting the server dial out with the old credentials. `caCertificate` is compared by
"was this field touched at all" rather than by value (it is stored encrypted, so telling
"resent unchanged" apart from "actually different" would mean decrypting on every unrelated
update); rounding toward asking for the password more often than strictly necessary is the safe
direction.

### Rate limiting
Three independent buckets gate `POST /v1/authn/ldap/sign-in`, in this order:
1. **Per-IP, route-level** — the same `@fastify/rate-limit` registration every `/v1/authn/*` route
   opts into (`AppSystemProp.API_RATE_LIMIT_AUTHN_MAX`/`_WINDOW`, operator-configured; see
   `ldap-authn-controller.ts`'s route config). Keys on the caller's IP alone, with no knowledge of
   which username is being attempted.
2. **`ldap-sign-in:{platformId}:{ip}:{normalizedUsername}`** (`ldapSignInRateLimit`, 10/60s) — caps
   attempts against one *username* from one *IP*.
3. **`ldap-sign-in:{platformId}:{normalizedUsername}`** (`ldapSignInRateLimit`, 30/60s) — caps
   attempts against one *username* regardless of source IP, which bucket 2 alone cannot do for a
   botnet spread across many source addresses.

Buckets 2 and 3 both use `ldapUsernameUtils.normalize`, the same normalisation the directory search
applies, so a Unicode-equivalent username can neither dodge the limit nor land in a bucket the
actual sign-in attempt disagrees with. Each counter increments via one Redis `MULTI`
(`SET key 0 EX <ttl> NX` + `INCR key`, not `EXPIRE ... NX` — the latter needs Redis 7, this is
compatible back to 2.6.12), closing the window where a concurrent request could observe the key
before it has a TTL; every reply in the `MULTI` is checked, and a Redis/`EXEC` failure refuses the
sign-in attempt (fail closed) with an error log, rather than crashing as an unhandled 500 or
silently allowing the attempt through unlimited. The per-username lockout trade this design makes
is recorded in "Accepted risks" below.

### Errors
`LDAP_DIRECTORY_UNREACHABLE`, `LDAP_BIND_ACCOUNT_REJECTED`, `LDAP_EMAIL_ATTRIBUTE_MISSING`,
`LDAP_ACCOUNT_COLLISION` are new; an unknown username and a wrong password both surface as the
existing `INVALID_CREDENTIALS` (anti-enumeration) — including when `jitProvisioning` is off for an
unrecognized directory user, and when a subject-attribute lookup on the matched entry fails.

### Anti-enumeration timing defense (app-sec L2)
The response body already can't distinguish "unknown username" from "known username, wrong
password" (both `INVALID_CREDENTIALS`), but *response latency* used to: an unknown username short-
circuited after one connect+search, while a known one paid for a second connect+bind. `ldapAuthnService.lookupDirectoryUser`
now performs a dummy `bindAsUser` — a fixed, directory-independent DN built only from the
platform's own `baseDn`, never the caller's username — on the "not found" path specifically
(`LdapStageError.notFound`), so both paths pay for the same second network round trip. The dummy
bind's own outcome is discarded either way; only its cost matters.

### Reverse-direction identity squatting guards (app-sec, round 2)
An LDAP identity's standing access to *any* platform must be provable by a `user_federated_identity`
row on that exact platform — proof it actually signed in through that platform's own directory —
never merely by the existence of a `user` row, which other flows can create with no directory
involvement at all:
- **Invitations** (`userInvitationsService.provisionUserInvitation`) — for a `provider === LDAP`
  identity, an invitation onto a platform where it has no existing federated row is refused (the
  invitation itself is left unprocessed, not deleted); a non-LDAP identity is unaffected.
- **`/switch-platform`** (`authenticationService`'s `getUserForPlatform`) — the same check, at the
  point of actually switching: a `user` row with no federated row on the target platform (e.g. one
  reached via a pre-fix invitation grant) refuses the switch with `AUTHORIZATION`, even though the
  `user` row itself exists.

Operationally, this also means **the configured email attribute must not be self-writable by the
directory entry it belongs to** — the existing-identity email match (`linkOrAdoptExistingIdentity`)
is one of the paths these guards protect, and a self-writable email attribute would let a directory
entry retarget which local account it links to. This is stated here for now; the admin-facing
config UI should carry the same warning next to the attribute-map email field.

## Local-password lockout for `provider === LDAP`
Enforced in the **service** layer, not controllers, so nothing can route around it:
- `userIdentityService.verifyIdentityPassword` — refuses with `INVALID_CREDENTIALS` before checking `verified`/comparing any hash
- `userIdentityService.updatePassword` — refuses with a `VALIDATION` error; `linkToFederatedProvider` calls it *before* flipping `provider`, so the scramble step itself is not blocked by its own guard
- `otpService.createAndSend` — silently no-ops for `OtpType.PASSWORD_RESET` (same shape as "no such email")
- GOOGLE/SAML have the same latent local-password gap and are explicitly **not** touched here (tracked separately, #547)

## Flags
`ApFlagId.LDAP_AUTH_ENABLED` — boolean, resolved off `platformUtils.getPlatformIdForRequest`, `true`
only when a config row exists **and** `config.enabled`. No secrets, no config shape.
`GET /v1/flags` is unauthenticated and hit on every sign-in page load; `flag.service.ts`'s `getAll`
resolves the platform id once and threads it to both this check and the theme lookup (previously
two separate `getPlatformIdForRequest` calls), so the LDAP flag's own cost is exactly one indexed
`findOneBy` on `platform_ldap_config`'s unique `platformId` index — already a single cheap query,
not something an added cache layer would improve, and a cache would itself go stale across
replicas after an admin disables LDAP.

## `AP_LDAP_ALLOW_LIST`
Same parser as `AP_SSRF_ALLOW_LIST` (`safeHttp.parseAllowList`, exported from
`packages/server/utils/src/safe-http.ts`) and the same `ssrfIpClassifier.isBlockedIp` classifier
from `@aiqadam/shared`, but a **separate** system prop (`AppSystemProp.LDAP_ALLOW_LIST`) — approving
a domain controller's subnet must not also open it to arbitrary outbound HTTP from qadams, and vice
versa.

## `ldapts` findings (Phase 1 investigation)
- **TLS `servername` is never derived automatically for either transport.** For `ldaps://`,
  `Client._connect()` calls `tls.connect(port, host, tlsOptions)`; Node only defaults `servername`
  to that `host` when it is *not* itself an IP literal — and the host guard requires dialing the
  vetted IP directly, so the default never fires. For `startTLS()`, the upgrade runs the
  caller-supplied options straight through `tls.connect` over an already-open plain socket, which
  carries no host at all. Both call sites in `ldap-client.ts` set `tlsOptions.servername` explicitly
  to the *original hostname*.
- **`rejectUnauthorized` default is Node's own (`true`)** — `ldapts` sets nothing itself, it forwards
  whatever `tlsOptions`/`startTLS` options are given straight to `tls.connect`. Disabling verification
  (`tlsVerify: false`) requires this code to pass `rejectUnauthorized: false` explicitly.
- **Errors never carry the submitted password.** `ldapts`'s `ResultCodeError` subclasses (e.g.
  `InvalidCredentialsError`) wrap only the numeric LDAP result code and the server's own RFC 4511
  `errorMessage` diagnostic text — never the request's bind DN or password.

## Connection lifecycle & concurrency (M1)
`ldap-client.ts` owns all of this:
- **Concurrency cap covers a connection's whole lifetime.** `withConnectionSlot`'s slot is held
  from `connect()` through the final `unbind()` — connect → bind → search → bind → unbind — not
  just the `connect()` call, so `MAX_CONCURRENT_LDAP_CONNECTIONS` (10) is a genuine bound on open
  connections, not merely concurrent in-flight connects.
- **Bounded wait, bounded queue.** A caller past the cap waits for a free slot for at most
  `CONNECTION_SLOT_WAIT_TIMEOUT_MS` (5s) before failing outright, and the waiter queue itself is
  capped (`MAX_CONNECTION_SLOT_WAITERS`, 50) so a large burst rejects immediately past that point
  rather than queuing everyone and letting each one time out independently.
- **Slot handoff, not decrement-then-increment.** `releaseConnectionSlot` hands a freed slot
  directly to the oldest waiter when one exists, and never decrements the active count in that
  case — the previous shape decremented unconditionally and let the woken waiter's own
  continuation re-increment later, leaving a window where a fresh acquirer could take the
  transiently-free slot on top of the waiter also about to claim it.
- **StartTLS handshake timeout.** `ldapts`'s `startTLS()` places no deadline on the TLS upgrade
  itself; `withStartTlsTimeout` races it against `LDAP_OPERATION_TIMEOUT_MS` and, on timeout, calls
  `client.unbind()` (the one public method that unconditionally destroys whatever socket the client
  currently holds) to force the stalled connection closed.
- **Cap on vetted IPs tried per attempt** (`MAX_VETTED_IPS_PER_ATTEMPT`, 4) — a multi-homed name
  with many records no longer turns one attempt into an unbounded number of connect attempts.
- **Scheme assertion in `connect()`.** Defense in depth alongside `LdapConfig`'s own
  `superRefine`: a row written before that check existed, or directly to the database, still gets
  refused at connect time rather than reaching the wire as a silent plaintext/StartTLS mismatch.
- **Plaintext-reconnect guard (StartTLS only).** `ldapts` computes whether a client is "secure"
  once, at construction, from the *original* scheme/`tlsOptions` — never updated after `startTLS()`
  upgrades the current socket — and every operation reconnects unconditionally whenever the socket
  is not currently connected, with no way to tell it "fail instead". `assertConnectionStillUpgraded`
  checks `client.isConnected` before `serviceBind`/`searchForUser`/the user bind and refuses rather
  than let `ldapts` silently redial in plaintext.
- **IPv6 literal brackets.** `URL#hostname` keeps the brackets around an IPv6 literal (`"[::1]"`);
  `stripIPv6Brackets` removes them before the host guard and the TLS `servername` see the value.
- **`tlsVerify: false` logs a warning on every connect**, not only at config-save time.

## Real-directory test suite in CI (M5)
`test/integration/ce/ldap/ldap-openldap.test.ts` is opt-in (`AP_RUN_LDAP_OPENLDAP_TESTS=true`) and
runs in the "CE integration suite" GitHub Actions job: a `run:` step generates a fresh TLS cert,
starts `ghcr.io/ldapjs/docker-test-openldap/openldap` pinned by digest, waits for slapd to actually
answer (`ldapwhoami` in a retry loop, not `nc -z` — `nc` only proves docker-proxy accepted the TCP
connection, before slapd itself is listening), resets the one seeded test account's password via
`ldappasswd`, then the next step opts the suite in via env var — with an `if: always()` cleanup
step after. Config in that suite is written through the real `POST /v1/platform-ldap-configs`
`upsert` handler (including the CA-certificate round trip), never by writing the
`platform_ldap_config` row directly.

The flag is `AP_`-prefixed, not a bare name — round 1 of this shipped it as
`RUN_LDAP_OPENLDAP_TESTS`, which turbo's `globalPassThroughEnv` (`AP_*`/`QF_*` only) silently
stripped before it ever reached the spawned `vitest` process, so all 8 cases skipped in CI without
failing the job. The suite itself now also fails outright (rather than skipping) whenever
`CI=true` and the flag isn't `'true'`, so a repeat of that regression is caught by the suite, not
only by a comment. This round's fix has not yet been proven by a real green CI run showing "8
passed" for this file — that confirmation is a follow-up, not a claim made here.

## Accepted risks
Recorded deliberately, not discovered late — each of these is a property of the design, not a bug:

- **(a) Whoever controls a platform's LDAP config controls every LDAP-managed account on that
  platform.** The owner (and, for non-sensitive fields, any platform admin) chooses `baseDn`,
  `userFilter` and `attributeMap` — including which attribute is `subject`. A directory admin who
  can edit an entry's subject attribute, or a Qadam Flow platform admin who can repoint the search
  filter to match a different entry, can retarget which directory identity an existing
  `user_federated_identity` row resolves to. This is the same trust boundary every identity
  provider integration has (whoever configures the IdP connection is trusted with the accounts it
  federates) — not something specific to this LDAP integration, and not something a code-level
  guard can close without refusing to let admins administer the directory connection at all.
- **(b) The connection-slot cap and the dummy-bind cost are shared across every platform on this
  process, not per-platform.** `MAX_CONCURRENT_LDAP_CONNECTIONS` (10) and the anti-enumeration
  dummy bind's extra connect+bind both draw from one process-wide pool — a platform with heavy
  sign-in traffic (legitimate or not) can exhaust slots or add latency that a different platform on
  the same process feels too. Per-platform caps are a Phase 2 item, not implemented here.
- **(c) The per-username rate-limit bucket (`ldap-sign-in:{platformId}:{normalizedUsername}`,
  30/60s) is keyed on the username alone, deliberately — the one dimension the per-IP bucket cannot
  cover for a botnet spread across many source addresses. The same property means a single attacker
  who merely knows (or guesses) a valid username can lock out every legitimate sign-in attempt for
  that username, from any IP, for the rest of the window — a denial-of-service against one account,
  not a credential-stuffing defense against many. This is the accepted trade for closing the botnet
  gap.

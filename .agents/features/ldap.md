# LDAP / Active Directory Sign-In (Phase 1 + Phase 2 group mapping/reconcile)

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
- **Stage** — `LdapTestStage` (`NOT_CONFIGURED`/`ALLOW_LIST`/`CONNECT`/`SERVICE_BIND`/`SEARCH`/`GROUP_SEARCH`/`USER_BIND`/`SUCCESS`), the unit the admin-only `/test` endpoint and internal error mapping both key on — `GROUP_SEARCH` (round 2) is exercised by `/test` only when the platform has `groupMappings` configured

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
| POST | `/v1/platform-ldap-configs/test` | platformAdminOnly (USER) | Connects through the host guard; optional test username/password exercises the full bind+search+user-bind path, including verifying the email/subject attributes actually resolve on the matched entry, and (only when `groupMappings` is non-empty) the group search itself, as its own `GROUP_SEARCH` stage; returns the failing `stage` + LDAP result code. Response schema is `LdapTestResponse`. |
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
if not the owner. The gate covers the secrets too: re-supplying `bindPassword` or `caCertificate`
while linking is on is also refused for a non-owner, even though a secret change is otherwise never
compared field-for-field against the stored value (there is nothing to compare a plaintext secret
against).

**Superseded by Phase 2 round 4, below:** turning `linkExistingByEmail` back off by itself is *no
longer* unrestricted for a non-owner, and `DELETE /v1/platform-ldap-configs` *does* now carry an
equivalent owner check — see "Owner gate, round 4" under "Save-time and apply-time validation" for
the current, safer rule and why the original "unrestricted turn-off" and "delete has no gate" design
described in this paragraph (accurate for Phase 1) was tightened.

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
config UI carries the same warning next to the attribute-map email field (see "Web UI" below).

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

## Web UI (Phase 1)
- `packages/web/src/app/routes/platform/security/sso/index.tsx` — the SSO settings page. The
  page-level `LockedFeatureGuard` (a CE-inappropriate paywall gate — see
  `.agents/rules/edition-safety.md`) is gone; **LDAP is the only item on this page that is actually
  wired to a working backend**, so it is the only one with a live control. Google, SAML, Allowed
  Domains and Allowed Email Login all show the same inline "Soon" badge — Google/SAML because their
  backend routes don't exist yet (`authenticationService.federatedAuthn` has zero callers,
  `/v1/authn/saml/*` 404s), and Allowed Domains/Allowed Email Login because `platform.plan.ssoEnabled`
  is hardcoded `false` in `platform.service.ts` for CE, which makes both
  `authentication-utils.ts#assertDomainIsAllowed` and `#assertEmailAuthIsEnabled` early-return before
  ever consulting `allowedAuthDomains`/`emailAuthEnabled` — those two controls looked live in an
  earlier revision of this UI (a review finding, not shipped) even though toggling them server-side
  did nothing. Correcting an earlier claim here: this is not "per-item unlocking" of the whole page —
  only LDAP moved from locked to functional; the other four items moved from a page-level lock to an
  item-level "Soon", which is a more honest but not a more capable state.
- `packages/web/src/app/routes/platform/security/sso/ldap-dialog.tsx` — `ConfigureLdapDialog` /
  `LdapConfigForm`: the full config form (URL, TLS mode/verify, CA cert, bind DN/password, base DN,
  user filter, attribute map — subject is a restricted `LdapSubjectAttribute` select, email carries
  the self-writable-attribute warning above — JIT/link-by-email switches with explicit
  takeover-risk copy, session length, enabled) plus a `TestConnectionPanel` that calls `POST …/test`
  — that endpoint always tests the **saved** row, never in-flight form values, so the panel only
  renders once a config exists. `linkExistingByEmail` is owner-only to touch, matching the
  server's gate, and while it is already on, a non-owner sees the **entire form** disabled with an
  explanatory banner (the server's gate is not limited to the switch itself, so the UI does not
  pretend other fields are safe to edit). Changing `url`/`bindDn`/`tlsVerify`/`tlsMode`/the CA cert
  requires re-entering the bind password before the client will submit, mirroring the server's own
  requirement. The request-shaping logic (empty-secret normalization, the bind-password re-supply
  matrix, the owner-lock check) lives in pure, independently unit-tested functions in
  `ldap-config-form-helpers.ts` rather than inline in the component — in particular, a blank
  `bindPassword`/`caCertificate` is normalized to `undefined` (never `''`) both at the input's own
  `onChange` and again in the request builder, because the shared schema's `.min(1)` rejects an
  empty string live (via `zodResolver`, on every keystroke) and an earlier revision that only
  normalized at submit time never reached that code at all once live validation had already failed.
  Deleting the config goes through the shared `ConfirmationDeleteDialog`, and both delete and the
  page's own quick-enable `Switch` surface a failed mutation via `apiErrorUtils.extractServerMessage`
  instead of failing silently.
- `packages/web/src/features/platform-admin/api/ldap-config-api.ts` /
  `hooks/ldap-config-hooks.ts` — CRUD + test client for `/v1/platform-ldap-configs`.
- `packages/web/src/app/components/sidebar/platform/index.tsx` — the SSO sidebar entry no longer
  carries `locked`/`badge: 'Soon'` (that gate lived on the whole page, which is no longer locked).
- `packages/web/src/features/authentication/components/ldap-login-form.tsx` — sign-in-only
  "directory account" mode (username, not email) calling `POST /v1/authn/ldap/sign-in`; maps each
  LDAP error code (plus a generic 429) to a distinct, actionable message and otherwise reuses the
  password sign-in's post-login handling (`authenticationSession.saveResponse` +
  `redirectAfterLogin`). Wired into
  `packages/web/src/features/authentication/components/auth-form-template.tsx` behind
  `ApFlagId.LDAP_AUTH_ENABLED`, sign-in only — LDAP has no sign-up screen, JIT provisioning happens
  through sign-in itself.

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
`test/integration/ce/ldap/ldap-openldap.test.ts` is opt-in (`QF_RUN_LDAP_OPENLDAP_TESTS=true`) and
runs in the "CE integration suite" GitHub Actions job: a `run:` step generates a fresh TLS cert,
starts `ghcr.io/ldapjs/docker-test-openldap/openldap` pinned by digest, waits for slapd to actually
answer (`ldapwhoami` in a retry loop, not `nc -z` — `nc` only proves docker-proxy accepted the TCP
connection, before slapd itself is listening), resets the one seeded test account's password via
`ldappasswd`, then the next step opts the suite in via env var — with an `if: always()` cleanup
step after. Config in that suite is written through the real `POST /v1/platform-ldap-configs`
`upsert` handler (including the CA-certificate round trip), never by writing the
`platform_ldap_config` row directly.

The flag is `QF_`-prefixed, not a bare name — round 1 of this shipped it as
`RUN_LDAP_OPENLDAP_TESTS`, which turbo's `globalPassThroughEnv` (`AP_*`/`QF_*` only) silently
stripped before it ever reached the spawned `vitest` process, so all 8 cases skipped in CI without
failing the job. The suite itself now also fails outright (rather than skipping) whenever
`CI=true` and the flag isn't `'true'`, so a repeat of that regression is caught by the suite, not
only by a comment. Round 2 (#339 Phase 2) renamed the canonical prefix from `AP_` to `QF_` — this
repo's general `AP_`→`QF_` migration (`env-migrations.ts`). Round 3 (#339 Phase 2, second review)
dropped the `AP_RUN_LDAP_OPENLDAP_TESTS` fallback the test file used to also read directly off
`process.env` — `QF_RUN_LDAP_OPENLDAP_TESTS` is the only name recognised now.

## Phase 2 — group→role mapping and reconcile

### Summary
The LDAP config's `config` json (`LdapConfig`, `packages/shared/src/lib/core/authentication/ldap/ldap-config.ts`)
gains `groupMappings: LdapGroupMapping[]`, `nestedGroups: boolean`, and optional `groupSearchBaseDn`/
`groupSearchFilter`. Each mapping is `{ groupDn, platformRole?, projects: [{ projectId, role }] }`.
Applied at every successful LDAP sign-in and by a reconcile system job: the platform role becomes
the *highest* matched role (`ADMIN > OPERATOR > MEMBER`); the platform owner is never changed;
project memberships the mapping creates are marked `managedBy: 'LDAP'` on `project_member` and are
the only ones reconcile or sign-in may update or remove — a manually-added membership (`managedBy:
'MANUAL'`) is never touched, even when it also matches a mapping. No mapping match at all leaves
the platform role untouched (not reset to anything).

### Key Files (additions)
- `packages/server/api/src/app/authentication/ldap/ldap-group-mapping.ts` — pure grant resolver: `resolveGrants({ groupMappings, memberGroupDns })` → highest-wins platform role + per-project role map; `normalizeGroupDn` (minimal RFC 4514 tokeniser — see accepted risk (e))
- `packages/server/api/src/app/authentication/ldap/ldap-group-mapping-service.ts` — `applyMapping`: writes the platform-role grant (skips the owner; round 2 adds provenance-gated revocation — see "Reconcile semantics") and the directory-managed `project_member` rows (create/update/remove via a race-safe conditional upsert — see "Reconcile semantics"), re-validating every `projectId` still belongs to the platform *and is still a TEAM project* (defense in depth; save-time validation is in `ldapConfigService.upsert`). No `entityManager` parameter — every write here runs against the default connection.
- `packages/server/api/src/app/authentication/ldap/ldap-reconcile-service.ts` — `reconcileAllPlatforms`: lists enabled platforms, then per platform under `distributedLock`, connects once and does one `searchBySubject` per linked user (bounded by a per-platform time budget — see "Reconcile semantics"); fail-open on a connect/bind error (touches nobody that run); fail-closed per account on a search error (skips only that user); a configurable safety valve — counting only real ACTIVE→gone/disabled transitions, against the ACTIVE linked-user count (round 2 fix) — aborts the whole platform run's deactivation half (deactivating nobody) if it would deactivate more than `LDAP_RECONCILE_SAFETY_VALVE_PERCENT` (default 20%) of that platform's currently-ACTIVE linked users
- `packages/server/api/src/app/authentication/ldap/ldap-reconcile-module.ts` — registers the `SystemJobName.LDAP_RECONCILE` handler and a repeated BullMQ job (default hourly, `LDAP_RECONCILE_CRON`, validated with `cron-parser` — `ldapReconcileModuleUtils.resolveReconcileCron`, falls back to the default on an invalid value rather than crashing server boot); the handler itself re-reads `LDAP_RECONCILE_ENABLED` every tick rather than the job being conditionally registered, so toggling the flag takes effect on the next tick with no restart; one shared job for every platform, not one per platform (see "Reconcile semantics")
- `ldap-client.ts` additions: `resolveMemberGroupDns` (reads `memberOf` on the already-fetched user entry, plus an optional nested-group search when `nestedGroups`+`groupSearchBaseDn`+`groupSearchFilter` are all configured), `searchNestedGroups` (templated `{userDn}` filter — AD's own nested-group idiom is `(member:1.2.840.113556.1.4.1941:={userDn})`, but the filter is admin-configured and directory-agnostic; OpenLDAP cannot evaluate that AD-specific extensible-match OID, so a plain `(member={userDn})` is what the real-directory test in `ldap-openldap.test.ts` actually exercises), `searchBySubject` (reconcile's own lookup — canonical `objectGUID` string is converted back to the RFC 4515 §3 escaped-octet filter syntax via `canonicalGuidToFilterValue`, the inverse of `ldapAttributeUtils.objectGuidBufferToCanonicalString`; round 2 guards the input against a canonical-GUID regex before converting, refusing a malformed stored `subject` rather than feeding it through the hex-pair conversion unchecked). `resolveMemberGroupDns`/`searchNestedGroups`/`searchBySubject` and the rest of `ldap-client.ts`'s Phase 2 surface landed in commit `31655702`.
- `searchForUser` now also requests `memberOf` unconditionally (cheap, needed by every sign-in for group mapping)
- `ldap-client.ts`'s `connect()` TLS `servername`: omitted (not just left as the dialed IP) when the *configured* host is itself an IP literal — Node's `tls.connect` warns (DEP0123) and ignores `servername` set to an IP address (RFC 6066 §3 restricts SNI to hostnames); `servername = hostname` is kept for a real DNS name

### Entities (columns added)
| Table | Column | Notes |
|---|---|---|
| `project_member` | `managedBy` | `ProjectMemberManagedBy` (`MANUAL`/`LDAP`), `NOT NULL DEFAULT 'MANUAL'`; every existing writer (`project-service.ts#addCreatorAsProjectAdmin`, `user-invitation.service.ts#provisionUserInvitation`) now sets it explicitly to `MANUAL` |
| `user_federated_identity` | `directoryDisabledAt` | nullable timestamptz; set only by reconcile when it deactivates a user, cleared only by reconcile when it reactivates one it deactivated itself, or when an admin explicitly writes that user's `status` through `POST /v1/users/:id` (round 2 — see "Reconcile semantics") |
| `user` | `platformRoleManagedBy` | `PlatformRoleManagedBy` (`MANUAL`/`LDAP`), `NOT NULL DEFAULT 'MANUAL'` (round 2) — tracks whether the current `platformRole` was last set by an admin or by a group mapping; gates revocation (see "Reconcile semantics") |

Migrations: `1791100000000-AddLdapGroupMappingColumns` (additive, non-breaking; both `project_member`
and `user_federated_identity` columns are plain `ADD COLUMN`) and
`1791200000000-AddPlatformRoleManagedByToUser` (additive, non-breaking; same shape, on `user`).
`groupMappings`/`nestedGroups`/`groupSearchBaseDn`/`groupSearchFilter` live inside the existing
`platform_ldap_config.config` json blob — no schema change needed for those.

### Save-time and apply-time validation
- Every `groupMappings[].projects[].projectId` must belong to the configuring platform **and** be a
  `TEAM` project — `ldapConfigService.upsert` throws `ErrorCode.VALIDATION` otherwise
  (`assertGroupMappingProjectsBelongToPlatform`). Re-checked again at apply time
  (`ldapGroupMappingService`'s own `projectBelongsToPlatformAsTeam`), since a project can be deleted,
  moved, or have its type changed after the mapping is saved — apply time silently skips (logs a
  warning) rather than throwing, since a background reconcile run must not fail outright over one
  stale entry.
- `groupSearchBaseDn` and `groupSearchFilter` are a pair: set one without the other and `LdapConfig`'s
  own `superRefine` refuses the save (`invalidLdapGroupSearchConfig`) — a lone `groupSearchBaseDn`
  would otherwise silently fall back to `memberOf`-only resolution with no indication why.
- **Owner gate, extended.** A group mapping with `platformRole: 'ADMIN'` is exactly as powerful as
  `linkExistingByEmail: true` — any directory user in that group becomes a platform admin on their
  next sign-in or the next reconcile pass — so saving or changing a config with such a mapping active
  requires the platform owner, the same `assertCallerIsPlatformOwner` gate `linkExistingByEmail`
  already used (`grantsPlatformAdminViaMapping` in `ldapConfigService.upsert`).
- **Owner gate, round 4: gated on the existing stored config OR the merged one, never the merged one
  alone.** Both `upsert` and `delete` check `linkExistingByEmail === true || grantsPlatformAdminViaMapping(...)`
  against `existingConfig` (`resolveStoredConfig` of what's on the row right now) as well as against
  the post-merge `config` a request would produce. Gating on the merged config alone let a non-owner
  admin submit one request that both turns `linkExistingByEmail` off (or drops the ADMIN mapping)
  *and* repoints `url`/`bindDn`/other fields in the same call — since the merged result no longer
  looked sensitive, the gate never fired, even though the request changed a config that, a moment
  before, was sensitive. The rule this repo takes throughout: **a non-owner may never touch a config
  that is, or was, in this sensitive state, full stop** — including turning the sensitive flag off by
  itself, with no other field touched. This is the deliberately safer of two possible rules; the
  alternative (letting a non-owner perform a *pure* "turn linking off" / "remove the ADMIN mapping"
  request with nothing else in the diff) was considered and rejected, since distinguishing "pure"
  from "bundled" reliably at the request boundary is itself an attack surface. A caller may still
  resend the exact same config unchanged (a genuine no-op, checked by `configHasChanged` against
  `existingConfig` — never against nothing) without being the owner; `bindPassword`/`caCertificate`
  are checked for having been touched at all, alongside `configHasChanged`, since both live outside
  `LdapConfig` and a non-owner could otherwise swap either one while the config stayed sensitive
  without the gate ever seeing a change.
- **`DELETE /v1/platform-ldap-configs` requires the owner** under the identical rule above, checked
  against the config actually stored on the row being deleted (there is no "merged" side for a
  delete) — whenever it has `linkExistingByEmail: true` **or** a group mapping granting
  `platformRole: 'ADMIN'`. Deleting is exactly as sensitive as changing a config in either sensitive
  state (it destroys the very row the upsert-time gate protects), so a non-owner admin cannot dodge
  either gate by deleting and re-creating an unchanged config instead of editing it in place.

### Reconcile semantics
- **Fail-open on outage, fail-closed per account.** A connect or service-bind failure aborts the
  whole platform's run (nobody touched, logged as an error). A `searchBySubject` failure for one
  specific linked user skips only that user (logged as a warning) — the rest of the platform's
  linked users are still processed normally.
- **Disabled-account detection is `userAccountControl` bit 2 (AD `ACCOUNTDISABLE`) only** in this
  PR. A configurable "disabled account filter" for directories using a different convention is a
  documented follow-up, not implemented here.
- **Safety valve** (`LDAP_RECONCILE_SAFETY_VALVE_PERCENT`, default 20, integer 1–100 only): round 2
  fixed a bug where both the numerator and the denominator counted every linked user, including
  ones already `INACTIVE` from a previous run (or a manual deactivation) that the directory still
  reports as gone/disabled every single tick — an already-mostly-inactive platform inflated both
  sides of the fraction and made the valve *harder* to trip for the still-active minority a real
  misconfiguration would actually be affecting. The valve now counts only real transitions: the
  numerator is gone/disabled results whose user is currently `ACTIVE`, and the denominator is the
  count of currently-`ACTIVE` linked users, not every linked user ever. Checked once after every
  user has been classified gone/disabled/present; tripping it aborts *only* the deactivation half of
  the run for that platform — reactivation and mapping re-application for present/enabled users
  still proceed, since those are the restorative direction and safe to apply even during a suspected
  `baseDn`/filter misconfiguration.
- **A broken group search never blocks sign-in, reconcile, or strips memberships.** Both
  `ldapAuthnService.lookupDirectoryUser` and reconcile's `resolveOneIdentity` wrap the group-search
  call in its own `tryCatch`; on failure they log it and carry `memberGroupDns: null` through
  instead of `[]` — `null` specifically means "unknown", so the caller skips calling
  `applyMapping` entirely for that one user this pass rather than calling it with an empty group
  list, which would read as "this user is in no groups" and strip every directory-managed project
  membership over what is usually a transient directory hiccup. Sign-in itself always proceeds; in
  reconcile, only that one user's mapping re-application is skipped, everyone else in the same run
  is unaffected. `POST /v1/platform-ldap-configs/test` exercises the same group search, as its own
  `GROUP_SEARCH` stage, but only when the platform actually has `groupMappings` configured.
- **Reactivation is scoped to reconcile's own marker.** Only a user whose federated row carries a
  non-null `directoryDisabledAt` is ever reactivated automatically; an admin's own manual
  deactivation carries no such marker and is never touched. Any explicit status write through the
  admin path (`userService.update` with a `status`, i.e. `POST /v1/users/:id`) now also *clears*
  `directoryDisabledAt` on that user's federated rows — otherwise a stale marker left over from a
  previous reconcile-driven deactivation could let a later reconcile pass reactivate a user an admin
  deliberately deactivated by hand afterwards. Reconcile's own status writes (`source: 'LDAP'`, the
  default for every caller in this file) manage the marker themselves and never trigger this clear;
  only `source: 'ADMIN'` (the admin controller's own default) does.
- **A directory-granted platform role is revocable, a manually-set one never is.** `user.platformRoleManagedBy`
  (`PlatformRoleManagedBy`: `MANUAL`/`LDAP`) tracks who last decided the role. A group mapping match
  always applies its role and always marks it `LDAP` — a real, current directory decision always
  wins regardless of what set the *previous* role. No matching group only *reverts* the role to
  `MEMBER`, and only when it is currently `LDAP`-managed; a manually-set role (e.g. an admin's own
  promotion via `POST /v1/users/:id`, which always writes `MANUAL`) is never touched by the absence
  of a mapping match. The platform owner is never touched either way, as before.
- **Only a TEAM project can receive a group-mapping grant.** Rejected with `ErrorCode.VALIDATION` at
  save time (`assertGroupMappingProjectsBelongToPlatform`) and silently skipped (logged) at apply
  time (`projectBelongsToPlatformAsTeam`) — a `PERSONAL` project has no meaningful shared-role
  concept for a directory group to grant.
- **`canonicalGuidToFilterValue` guards its input with a canonical-GUID regex** before converting it
  to the RFC 4515 §3 escaped-octet filter syntax reconcile's `searchBySubject` uses — a malformed
  stored `subject` (any shape that isn't the canonical mixed-endian GUID string
  `ldapAttributeUtils.objectGuidBufferToCanonicalString` produces) is refused rather than fed through
  the hex-pair conversion unchecked.
- **The directory-managed membership upsert closes a race, not just a pre-check.** `applyProjectGrants`
  still checks in JS whether an existing `project_member` row is `MANUAL` before ever attempting to
  write it, but the write itself (`upsertLdapManagedMembership`) is `INSERT ... ON CONFLICT
  ("userId", "projectId") DO UPDATE ... WHERE "managedBy" = 'LDAP'` — a plain unconditional upsert
  would still let a concurrent write (e.g. an invitation acceptance creating the MANUAL row in the
  exact window between this function's own pre-check and its insert) get overwritten; the
  conditional `WHERE` on the conflict target makes the guarantee atomic, not just best-effort.
- **No stray `entityManager` threading.** Earlier drafts of `ldapGroupMappingService` accepted an
  `entityManager` param that nothing used — removed entirely rather than half-wired, since every
  write here (`userService.update`, `projectMemberRepo()` calls) already runs against the default
  connection and reconcile has no enclosing transaction to join.
- **Per-platform time budget, and cron validation, so one bad config can't take down every
  platform's reconcile.** `collectDirectoryState` bounds its per-user loop against a deadline
  (`LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS`, default 60s) — a single slow or huge directory stops
  early, leaving its remaining linked users for the next scheduled tick, rather than starving every
  other platform's own turn in the same run. Separately, `LDAP_RECONCILE_CRON` is validated with
  `cron-parser` before being handed to BullMQ's own repeat-pattern scheduling
  (`ldapReconcileModuleUtils.resolveReconcileCron`) — an invalid value falls back to the default and
  logs an error at boot, rather than throwing and crashing the entire server over a typo in one
  optional background job's schedule string.
- **Single BullMQ job, not one per platform (design note).** `ldapReconcileModule` registers exactly
  one repeated job (`SystemJobName.LDAP_RECONCILE`) whose handler loops every enabled platform each
  tick, rather than a per-platform BullMQ schedule. Simpler (no schedule bookkeeping to add/remove as
  platforms are created/deleted/toggled) and the per-platform time budget above already bounds one
  platform's worst case within a single tick, so a per-platform schedule buys nothing a shared one
  with a budget doesn't already give.

### System props (new)
`LDAP_RECONCILE_ENABLED` (boolean, default `true`), `LDAP_RECONCILE_CRON` (string, default
`23 * * * *` — hourly, validated with `cron-parser` at boot, falls back to the default on an invalid
value), `LDAP_RECONCILE_SAFETY_VALVE_PERCENT` (integer 1–100 only, default `20`),
`LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS` (positive integer, default `60000`).

### Env-migration follow-up folded in
`test/integration/ce/ldap/ldap-openldap.test.ts`'s opt-in flag is `QF_RUN_LDAP_OPENLDAP_TESTS` —
see the "Real-directory test suite in CI (M5)" section above. The `AP_RUN_LDAP_OPENLDAP_TESTS`
fallback the test file used to also read directly off `process.env` was dropped in round 3 of this
review; `QF_` is the only name recognised now.

### Tests (Phase 2)
- Pure resolver: `test/unit/app/authentication/ldap/ldap-group-mapping.test.ts` — highest-wins
  platform role, no-match leaves role untouched, highest-wins per project; a dedicated round-2 block
  covers the RFC 4514 tokeniser directly against the three spoofing vectors its own design comment
  documents (an escaped comma followed by a space vs. not, a trailing NBSP, a Kelvin-sign lookalike)
  plus a positive case for genuine case/spacing differences.
- `test/unit/app/authentication/ldap/ldap-client.test.ts` — `canonicalGuidToFilterValue` round-trips
  a known `objectGUID` vector and refuses a malformed subject rather than converting it.
- `test/unit/app/authentication/ldap/ldap-reconcile-module.test.ts` —
  `ldapReconcileModuleUtils.resolveReconcileCron` falls back to the default (and logs) on an unset,
  empty, or invalid `LDAP_RECONCILE_CRON`, and passes a valid one through unchanged.
- DB-backed: `test/integration/ce/ldap/ldap-group-mapping.test.ts` — owner never changed; directory-managed
  membership create/update/remove; manual membership untouched even when it matches a mapping; a
  stale cross-platform `projectId` is skipped (not thrown) at apply time; a non-TEAM project's grant
  is ignored at apply time; a MANUAL row can never flip to `LDAP` even when the JS-level pre-check
  misses it under a simulated race; a group-granted platform role is marked `LDAP`-managed and
  reverts to `MEMBER` once no mapping matches, while a manually-granted role is never demoted by that
  absence.
- Reconcile: `test/integration/ce/ldap/ldap-reconcile.test.ts` — deactivates gone/disabled users and
  stamps `directoryDisabledAt`; reactivates only directory-deactivated users, never a manual
  deactivation; fail-open on a connect/bind error; fail-closed per account on a search error; the
  safety valve aborting deactivation for an over-threshold run; a round-2 case seeds 100 linked
  users (25 already `INACTIVE` and permanently reported gone, 74 `ACTIVE` and present, 1 `ACTIVE`
  and newly gone) and confirms only the one real departure is deactivated, proving the valve counts
  real transitions against the ACTIVE denominator rather than tripping on the stale majority; group
  mappings are re-applied (and revoked) on every reconcile pass; a group-search failure for one
  user is skipped for that user only, with every other present user still processed normally; a
  disabled config is skipped entirely (no directory call made at all).
- Save/apply validation and owner gates: appended to `test/integration/ce/ldap/ldap-config.test.ts`
  (ADMIN-granting-mapping owner gate on both upsert and delete, cross-platform `projectId` rejected
  at save with the specific status code the route actually returns, a non-TEAM project rejected at
  save, DELETE owner gate, and a Phase-1-shaped config row — missing `groupMappings`/`nestedGroups`
  entirely from its stored JSON — backfilling schema defaults on both the sign-in-facing resolved
  config and the GET response).
- `test/integration/ce/ldap/ldap-config-test-endpoint.test.ts` — `/test`'s own `GROUP_SEARCH` stage:
  never exercised when the platform has no group mappings, its own failure stage (not `SEARCH`) when
  group resolution fails and mappings exist, and a successful pass-through when both a mapping and a
  successful resolution are present.
- Real directory: `ldap-openldap.test.ts` gained one case applying a group mapping resolved via a
  real `(member={userDn})` search against the planetexpress fixture's real `cn=ship_crew` group,
  confirming the mapped platform role is actually granted — see the file's own comment for what this
  specific fixture cannot prove (no `memberOf` back-link overlay; OpenLDAP cannot evaluate AD's
  `LDAP_MATCHING_RULE_IN_CHAIN` OID, so the nested-group *transitive*-membership case stays covered
  only by the mocked tests).

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
- **(d) Per-platform connection caps are still not implemented (Phase 2 note on (b)).** Reconcile
  shares the same process-wide `MAX_CONCURRENT_LDAP_CONNECTIONS` pool sign-in uses; a platform with
  many linked users being reconciled can transiently reduce the slots available to another
  platform's sign-ins. Reconcile processes platforms and users sequentially (no internal
  concurrency), which bounds its own contribution but does not eliminate this.
- **(e) DN comparison for group mappings is a minimal RFC 4514 tokeniser, not a full parser.**
  Round 2 of this review found the original "trim + lowercase each comma-separated component"
  version was a privilege-escalation hole, not just an approximation: `String#trim()` strips U+00A0
  NBSP (a trailing-NBSP group name would compare equal to the real one), `String#toLowerCase()`
  performs full Unicode case folding (a Kelvin-sign-built name would compare equal to plain ASCII),
  and splitting on every literal `,` ignores RFC 4515's `\,` escape (an escaped comma inside a
  value would be misread as a component boundary). `ldapGroupMappingUtils.normalizeGroupDn` now
  splits only on an *unescaped* `,`/`+`, trims only a literal ASCII space (0x20) at each raw
  component's boundary (never NBSP, and never inside an escape sequence), and lowercases only ASCII
  `A`–`Z` (never folding non-ASCII codepoints) — closing all three holes. It still does not handle
  attribute-type OID vs. short-name equivalence (`2.5.4.3` vs `cn`) or the semantic ordering of a
  multi-valued RDN; a group DN using either form would need to be entered into `groupMappings` in
  whatever form the directory actually reports it in.
- **(f) Disabled-account detection covers AD's `userAccountControl` bit 2 only.** A directory that
  signals "disabled" a different way (a custom attribute, a different bit, group membership) is not
  detected by reconcile; such an account is only caught by "gone" (searchBySubject returns nothing)
  if it is also removed from the directory, not merely disabled. A configurable disabled-account
  filter is a natural follow-up, not implemented in this PR.

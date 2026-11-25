# MFA (TOTP)

## Summary
Platform-wide second factor using TOTP (RFC 6238, authenticator apps), with an admin-controlled
enforcement switch. Applies to the two interactive sign-in paths that actually exist in this CE
repo — local email/password and LDAP — plus the `switchPlatform` reissue. A per-identity
`mfaEnabled` flag means "this identity is always challenged"; a per-platform `mfaEnforced` flag
means "any identity signing into *this* platform without MFA must enrol before it gets a session."
Both are evaluated by `mfaService.beginMfaGate`, the single gate every first-factor success passes
through before a real session token is minted. A challenge or forced-enrolment response carries a
short-lived, single-purpose, single-use "MFA pending" token (`mfaToken`) instead of a session
token — it is accepted only by the `/v1/mfa/*` endpoints below, never by the normal authorization
middleware.

**Scope note:** the issue this shipped under (#898) also asked for Google/SAML sign-in to be
gated. Searching the server at the time found no OAuth2/SAML callback controller anywhere in this
CE repo — `authenticationService.federatedAuthn` exists and is MFA-gated the same way as the other
paths, but nothing calls it; Google/SAML sign-in itself is not an implemented, reachable flow here
yet. That is a pre-existing gap, not something this feature introduces or can test.

## Key Files
- `packages/server/api/src/app/authentication/mfa/mfa-service.ts` — the gate (`beginMfaGate`),
  enrolment (pending and self-service), disable, recovery-code regeneration, admin reset
- `packages/server/api/src/app/authentication/mfa/totp.ts` — RFC 6238 TOTP (hand-rolled, no
  dependency), constant-time verify with a ±1 step window
- `packages/server/api/src/app/authentication/mfa/mfa-pending-token.ts` — the `mfaToken`: a
  Redis-backed, single-use, JWT-signed claim bound to the first-factor identity
- `packages/server/api/src/app/authentication/mfa/mfa-rate-limit.ts` — per-identity and per-IP
  fixed-window limiter for challenge/enrolment attempts, same shape as the LDAP sign-in limiter
- `packages/server/api/src/app/authentication/mfa/mfa.controller.ts` / `mfa.module.ts` — routes
  under `/v1/mfa`
- `packages/server/api/src/app/authentication/authentication.service.ts` — `signUp`,
  `signInWithPassword`, `federatedAuthn`, `switchPlatform` all route their final token issuance
  through `mfaService.beginMfaGate` instead of calling `authenticationUtils.getProjectAndToken`
  directly
- `packages/server/api/src/app/authentication/ldap/ldap-authn-service.ts` — `signIn` routes
  through the same gate; LDAP is never a "trust the IdP" provider (a bind carries no
  authentication-context signal, #339) — it always challenges locally when it applies
- `packages/server/api/src/app/authentication/user-identity/user-identity-entity.ts` — `mfaEnabled`,
  `mfaSecret`/`mfaPendingSecret` (AES-encrypted via `encryptUtils`, same as the LDAP bind
  password), `mfaRecoveryCodes` (SHA-256 hashes), `mfaEnrolledAt`, `mfaLastUsedStep` (the replay
  guard)
- `packages/server/api/src/app/platform/platform.entity.ts` — `mfaEnforced`,
  `mfaEnforcementGracePeriodDays`, `mfaTrustedIdpProviders`, `mfaEnforcementEnabledAt`
- `packages/server/api/src/app/database/migration/postgres/1795585617485-AddMfaToUserIdentityAndPlatform.ts`
- `packages/shared/src/lib/core/authentication/mfa/mfa.ts` — request/response Zod schemas
- `packages/shared/src/lib/core/authentication/dto/authentication-response.ts` — `SignInResponse`
  (`AuthenticationResponse | MfaChallengeResponse`) and
  `MfaEnrollmentConfirmWithSessionResponse`

## Endpoints

| Method | Path | Security | Purpose |
|---|---|---|---|
| POST | `/v1/mfa/challenge/verify` | public, `mfaToken`-bound | Verify a TOTP/recovery code for a pending sign-in |
| POST | `/v1/mfa/enroll/pending/start` | public, `mfaToken`-bound | Start forced enrolment (enforcement on, no MFA yet) |
| POST | `/v1/mfa/enroll/pending/confirm` | public, `mfaToken`-bound | Finish forced enrolment; returns a session + recovery codes |
| GET | `/v1/mfa/status` | authenticated user | `{ enrolled, recoveryCodesRemaining, enforced }` |
| POST | `/v1/mfa/enroll/start` | authenticated user | Self-service enrolment start (re-auth required) |
| POST | `/v1/mfa/enroll/confirm` | authenticated user | Self-service enrolment confirm; returns recovery codes |
| POST | `/v1/mfa/disable` | authenticated user | Disable MFA (re-auth required); rotates `tokenVersion` |
| POST | `/v1/mfa/recovery-codes/regenerate` | authenticated user | Re-auth required |
| POST | `/v1/mfa/admin/reset/:userId` | platform admin only | Clears a user's MFA; never the owner; a non-owner admin cannot reset another admin |

Admin enforcement policy itself is read/written through the existing `POST /v1/platforms/:id`
(`UpdatePlatformRequestBody.mfaEnforced` / `mfaEnforcementGracePeriodDays` /
`mfaTrustedIdpProviders`) — no separate endpoint. `platform.controller.ts` emits
`ApplicationEventName.MFA_ENFORCEMENT_TOGGLED` when `mfaEnforced` actually changes.

## Domain Terms
- **MFA pending token (`mfaToken`)** — proves the first factor succeeded; carries no session
  rights; single-use (deleted from Redis on success); accepted only by `/v1/mfa/*`
- **Forced enrolment** — enforcement is on and the identity has no MFA; the pending token's
  purpose is `ENROLL` rather than `CHALLENGE`, and enrolling it finishes the pending sign-in too
- **Trusted provider** — a federated provider the platform has opted to trust for its own MFA
  assertion instead of challenging locally (`mfaTrustedIdpProviders`); LDAP and JWT (embedded) can
  never be in this set
- **Replay guard (`mfaLastUsedStep`)** — the highest TOTP time-step ever accepted for an identity;
  a code for that step or earlier is refused even if it is otherwise valid

## Audit Events
`USER_MFA_ENROLLED`, `USER_MFA_DISABLED`, `USER_MFA_RESET` (admin), `USER_MFA_CHALLENGE_SUCCEEDED`,
`USER_MFA_CHALLENGE_FAILED`, `MFA_ENFORCEMENT_TOGGLED` — all in
`packages/shared/src/lib/automation/audit-events/index.ts`.

## Owner break-glass

The platform owner's recovery codes are the primary break-glass. Beyond that, `disable` (not
`regenerateRecoveryCodes` or `startAuthenticatedEnrollment`) accepts the owner's **password**
instead of a code (`tryOwnerPasswordBypass` in `mfa-service.ts`) — but only from an already
authenticated session, since `disable` requires one. If the owner loses the authenticator app,
all recovery codes, *and* has no other active session, there is deliberately no in-app path back
in: `adminReset` refuses to ever target the owner (`MFA_RESET_NOT_ALLOWED_FOR_OWNER`), because any
automated path that *could* clear the owner's MFA without already being the owner is also a
takeover primitive against the one identity this platform must never let another admin take over.
The documented recovery for that case is a direct, operator-level SQL update against
`user_identity` — see `docs/admin-guide/guides/mfa.mdx`. This mirrors the LDAP design's own
owner protection (no directory can ever adopt or link the owner's identity) rather than
reimplementing it.

## Out of scope (deferred, per the issue)
WebAuthn/passkeys, SMS/email OTP as a second factor, SCIM, per-role/per-group enforcement scope
(platform-wide only today), and a CLI recovery path for operators without UI/API access (the admin
reset endpoint is the only operator-facing reset path right now).

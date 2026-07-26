# CE Platform Configuration

## Summary
A Platform is the top-level tenant namespace in Activepieces. Every installation has at least one platform. It owns branding (logo, colors, favicon), authentication settings (email auth toggle, allowed auth domains, federated SSO providers), piece filtering rules, and a `PlatformPlan` that governs feature flags and resource limits. An identity can own more than one platform (`listPlatformsForIdentityWithAtleastProject` powers the platform switcher), though a self-hosted install normally has one. Platform admins can update branding, auth settings, and piece pinning. There is no delete-platform route: `platform.controller.ts` registers only `POST /`, `POST /:id`, `GET /:id` and `GET /assets/:id`.

## Key Files
- `packages/server/api/src/app/platform/platform.controller.ts` — POST `/` (create), POST `/:id` (update), GET `/:id` (read), GET `/assets/:id` (logo/favicon download)
- `packages/server/api/src/app/platform/platform.service.ts` — CRUD service; `create`, `update`, `getOneWithPlanAndUsageOrThrow`, `listPlatformsForIdentityWithAtleastProject`
- `packages/server/api/src/app/platform/platform.entity.ts` — `platform` TypeORM entity
- `packages/server/api/src/app/platform/platform.utils.ts` — `getPlatformIdForRequest`, `isCustomerOnDedicatedDomain`
- `packages/server/api/src/app/platform/platform-jobs.ts` — `HARD_DELETE_PLATFORM` job handler
- `packages/shared/src/lib/management/platform/platform.model.ts` — `Platform`, `PlatformWithoutSensitiveData`, `PlatformPlan`, `PlatformUsage` Zod schemas
- `packages/shared/src/lib/management/platform/platform.request.ts` — `UpdatePlatformRequestBody`
- `packages/web/src/hooks/platform-hooks.ts` — `useCurrentPlatform()` React Query hook
- `packages/web/src/features/platform-admin/hooks/branding-hooks.ts` — branding mutation hooks

## Domain Terms
- **Platform** — tenant root; owns branding, auth config, piece filters
- **PlatformPlan** — a Zod schema of feature flags and limits in `packages/shared`, **not** a TypeORM entity and not a table; `platformService.getPlan()` returns a fixed object (most flags hardcoded `false`, `tablesEnabled`/`agentsEnabled`/`aiProvidersEnabled`/`analyticsEnabled` `true`), and the Stripe/licence fields on the schema are inert — no billing code exists in this repo
- **FilteredPieceBehavior** — `ALLOWED` (allowlist) or `BLOCKED` (blocklist) applied to `filteredPieceNames`
- **federatedAuthProviders** — JSONB column storing OAuth2 / SAML config; sensitive fields (secrets, certs) are stripped before returning `PlatformWithoutSensitiveData`
- **pinnedPieces** — ordered list of piece names shown at the top of the piece selector
- **cloudAuthEnabled** — whether platform-managed OAuth (Activepieces-hosted app credentials) is active

## Entity

### `platform` (`PlatformEntity`)
| Column | Type | Notes |
|---|---|---|
| id | string | ApId |
| ownerId | string | FK to `user` |
| name | string | display name |
| primaryColor | string | hex color for UI theme |
| logoIconUrl | string | small logo asset URL |
| fullLogoUrl | string | full logo asset URL |
| favIconUrl | string | favicon asset URL |
| cloudAuthEnabled | boolean | default true |
| filteredPieceNames | string[] | allow/block list |
| filteredPieceBehavior | string | `FilteredPieceBehavior` enum |
| allowedAuthDomains | string[] | email domain allowlist |
| enforceAllowedAuthDomains | boolean | |
| emailAuthEnabled | boolean | |
| federatedAuthProviders | jsonb | OAuth2 + SAML config |
| pinnedPieces | string[] | ordered piece name list |

## Endpoints

| Method | Path | Security | Description |
|---|---|---|---|
| POST | `/v1/platforms` | platformAdminOnly (USER) | Create a platform |
| GET | `/v1/platforms/:id` | publicPlatform (USER, SERVICE) | Get platform with the fixed plan flags attached; `usage` is always undefined and sensitive SSO data is stripped |
| POST | `/v1/platforms/:id` | platformAdminOnly (USER) | Update branding, auth settings, piece filters |
| GET | `/v1/platforms/assets/:id` | public | Download a platform asset (logo/favicon) by file ID |

## Service Methods

### `platformService`
- `create({ ownerId, name, primaryColor?, logoIconUrl?, fullLogoUrl?, favIconUrl? })` — creates platform record with defaults from `defaultTheme`; calls `userService.addOwnerToPlatform`
- `update(params)` — merges the branding / auth / qadam-filter / pinned-qadam fields onto the row and saves it. There is no plan write path: no `platformPlanService` exists, and the `plan` field on `UpdateParams` is never persisted.
- `getOneWithPlanAndUsageOrThrow(id)` — read with the fixed plan flags attached; `usage` is always `undefined` because `getUsage()` returns `undefined` unconditionally
- `getOneWithPlanOrThrow(id)` — plan flags only (no usage); used in auth guards for fast plan checks
- `listPlatformsForIdentityWithAtleastProject({ identityId })` — returns all platforms where the identity has at least one accessible project; used for platform-switcher
- `getOldestPlatform()` — used in CE for single-platform setup resolution

## Side Effects
- On `update` with branding files: `fileService.uploadPublicAsset` is called for logo/icon/favicon before saving

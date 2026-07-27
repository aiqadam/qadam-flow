# CE Project Management

## Summary
A Project is the workspace within a platform where flows, connections, tables, and other resources live. Every platform has at least one project. Projects are always scoped to a platform via `platformId`. A user gets one PERSONAL project on sign-up, and `POST /v1/projects` creates additional TEAM projects. There is no separate platform-projects module in this repo: no `platformProjectService`, no per-plan quota (`platform.plan.*` is never read for this purpose — `platformService.getPlan()` hardcodes `TeamProjectsLimit.UNLIMITED`, per edition-safety.md), and no per-project qadam filters. TEAM project creation is capped by the edition-neutral system prop `AP_MAX_TEAM_PROJECTS_PER_PLATFORM` (unset/non-positive/malformed = unlimited, the default); see "TEAM-projects cap" below. Projects support soft-delete (via `deleted` timestamp), icon customization, concurrency pool assignment, and optional release management.

## Key Files
- `packages/server/api/src/app/project/project-controller.ts` — POST `/` (create TEAM project), POST `/:id` (update), GET `/` (list), DELETE `/:id` (soft delete)
- `packages/server/api/src/app/project/project-service.ts` — core service: `create`, `update`, `getOne`, `getOneOrThrow`, `getAllForUser`, `getUserProjectOrThrow`
- `packages/server/api/src/app/project/project-entity.ts` — `project` TypeORM entity with all relations
- `packages/server/api/src/app/project/project-repo.ts` — `repoFactory` wrapper with optional `EntityManager` support
- `packages/server/api/src/app/project/project-hooks.ts` — `hooksFactory` hook point for post-create behaviour; the default `postCreate` is a no-op and nothing overrides it
- `packages/server/api/src/app/project/project-worker-controller.ts` — internal endpoint used by engine to read project data
- `packages/shared/src/lib/management/project/project.ts` — `Project`, `ProjectPlan`, `ProjectIcon`, `UpdateProjectRequestInCommunity` schemas
- `packages/web/src/features/projects/components/projects-selector.tsx` — project-switcher dropdown in the sidebar
- `packages/web/src/features/projects/components/platform-switcher.tsx` — platform-level switcher component
- `packages/web/src/features/projects/stores/project-collection.ts` — Zustand store for current project

## Domain Terms
- **ProjectType** — `PERSONAL` (auto-created on sign-up, one per user per platform) or `TEAM` (multi-member workspace)
- **ProjectIcon** — `{ color: ColorName }` stored as JSONB; color chosen from a 12-color palette
- **externalId** — optional opaque string for embedding integrations to map projects to their own IDs
- **releasesEnabled** — feature flag per-project for the project-releases module
- **poolId** — optional FK to a `concurrency_pool` for worker concurrency limiting
- **maxConcurrentJobs** — optional per-project override for concurrent execution limit

## Entity

### `project` (`ProjectEntity`)
| Column | Type | Notes |
|---|---|---|
| id | string | ApId |
| ownerId | string | FK to `user` |
| platformId | string | FK to `platform` |
| displayName | string | |
| type | string | `ProjectType` enum |
| icon | jsonb | `{ color: ColorName }` |
| externalId | string (nullable) | embedding integration ID |
| maxConcurrentJobs | number (nullable) | concurrency cap |
| releasesEnabled | boolean | default false |
| metadata | jsonb (nullable) | arbitrary key-value |
| poolId | string (nullable) | FK to `concurrency_pool` |
| deleted | timestamp (nullable) | soft-delete date |

Indices: `ownerId`, `platformId`, `poolId`, unique `(platformId, externalId)` where `deleted IS NULL`.

Relations (one-to-many): `flows`, `files`, `folders`, `events`, `appConnections`, `tables`, `fields`, `records`, `cells`, `tableWebhooks`.

## Endpoints

| Method | Path | Security | Description |
|---|---|---|---|
| POST | `/v1/projects` | publicPlatform (USER) | Create a TEAM project |
| GET | `/v1/projects` | publicPlatform (USER) | List projects visible to the current user (`getAllForUser`) |
| POST | `/v1/projects/:id` | publicPlatform (USER, SERVICE) | Update project display name and metadata |
| DELETE | `/v1/projects/:id` | publicPlatform (USER) | Soft delete, then `projectSideEffects.postSoftDelete` |

## Service Methods

### `projectService`
- `create({ displayName, ownerId, platformId, type, callPostCreateHooks?, postCreateContext?, entityManager? })` — creates project record with random icon color, then calls `projectHooks.postCreate(savedProject, postCreateContext)` when `callPostCreateHooks` is set (defaults to true). `ProjectPostCreateContext` declares `alertReceiverEmail?: string | null`, but the default hook body returns immediately and no implementation is registered, so nothing is auto-subscribed.
- `update(projectId, request, entityManager?)` — updates allowed fields; TEAM projects allow `displayName` and `icon` update; PERSONAL projects do not
- `getOne(projectId)` / `getOneOrThrow(projectId)` — single project fetch
- `getAllForUser({ platformId, userId, isPrivileged })` — returns all projects visible to a user (admins see all platform projects, members see their assigned projects)
- `getUserProjectOrThrow(userId)` — returns the personal project owned by the user
- `getProjectIdsByPlatform(platformId)` — returns all project IDs for a platform; used by `health-metrics.service.ts` and `flow.service.ts`
- `countByPlatformIdAndType({ platformId, type, entityManager? })` — counts projects of a type on a platform (soft-deleted rows excluded automatically, since `ProjectEntity.deleted` is a TypeORM `deleteDate` column); called by the TEAM-projects cap check below

## TEAM-projects cap
- `AP_MAX_TEAM_PROJECTS_PER_PLATFORM` (system prop, `system-validator.ts` validates it with `numberValidator`) caps how many TEAM projects a platform may have. Unset, non-numeric, or `<= 0` all mean **unlimited** — `getMaxTeamProjectsPerPlatform()` in `project-service.ts` fails open, never closed to zero, so a malformed or missing value cannot lock a platform out of TEAM-project creation. A malformed value only produces a `log.warn` at startup (`validateEnvPropsOnStartup`); it does not throw or block the process.
- Only `ProjectType.TEAM` counts. PERSONAL projects are created as a side effect of user onboarding (`user-service.ts`) and platform bootstrap (`platform.service.ts`), outside caller control, so they are deliberately excluded from the cap.
- When a finite cap is configured, `createTeamProject()` wraps the count (`countByPlatformIdAndType`) and the insert in `distributedLock(log).runExclusive({ key: 'team-project-limit:${platformId}', ... })` to close the count-then-insert race between concurrent requests. When no cap is configured (the default), the lock is skipped entirely — no Redis round trip on the common path.
- Breaching the cap throws `QadamFlowError({ code: ErrorCode.RESOURCE_LIMIT_EXCEEDED, params: { resource: 'team_projects', limit } })`, mapped to HTTP `403` in `error-handler.ts`. This is a dedicated code, deliberately distinct from `ErrorCode.QUOTA_EXCEEDED`/`FEATURE_DISABLED` (plan/billing vocabulary reserved for a real plan-persistence feature that doesn't exist in this repo) and from `PlatformUsageMetric` (plan-usage vocabulary with no `teamProjects` field).

## Side Effects
- Creating a project calls `projectHooks.postCreate(project, context?)`. The only registered implementation is the no-op default in `project-hooks.ts` — no `ProjectPlan` row, qadam filter, or alert receiver is created.
- Soft-deleted projects remain in DB and can be hard-deleted by a background job
- Deleting a project runs the soft-delete and the `alert`-row sweep inside a single transaction in `projectService#softDelete`, via a `projectHooks.postSoftDelete({ entityManager, projectId })` hook registered from `alerts-module.ts` (`project/project-hooks.ts`). The `alert` table has no FK to `project`, and soft-delete would not fire a cascade anyway, so the rows need an explicit, transactional sweep — otherwise a sweep failure would leave the project soft-deleted with its alert rows orphaned and unreachable by any retry.

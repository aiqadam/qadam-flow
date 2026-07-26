# CE Project Management

## Summary
A Project is the workspace within a platform where flows, connections, tables, and other resources live. Every platform has at least one project. Projects are always scoped to a platform via `platformId`. A user gets one PERSONAL project on sign-up, and `POST /v1/projects` creates additional TEAM projects. There is no separate platform-projects module in this repo: no `platformProjectService`, no project-limit enforcement (`projectsLimit` is never read, and `countByPlatformIdAndType` has no caller), and no per-project qadam filters. Projects support soft-delete (via `deleted` timestamp), icon customization, concurrency pool assignment, and optional release management.

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
- `create({ displayName, ownerId, platformId, type, callPostCreateHooks?, postCreateContext?, entityManager? })` — creates project record with random icon color, calls `projectHooks.postCreate(savedProject, postCreateContext)`. `ProjectPostCreateContext` declares `alertReceiverEmail?: string | null`, but the default hook body returns immediately and no implementation is registered, so nothing is auto-subscribed.
- `update(projectId, request, entityManager?)` — updates allowed fields; TEAM projects allow `displayName` and `icon` update; PERSONAL projects do not
- `getOne(projectId)` / `getOneOrThrow(projectId)` — single project fetch
- `getAllForUser({ platformId, userId, isPrivileged })` — returns all projects visible to a user (admins see all platform projects, members see their assigned projects)
- `getUserProjectOrThrow(userId)` — returns the personal project owned by the user
- `getProjectIdsByPlatform(platformId)` — returns all project IDs for a platform; used by `health-metrics.service.ts` and `flow.service.ts`
- `countByPlatformIdAndType(platformId, type)` — counts projects of a type on a platform; currently has no caller

## Side Effects
- Creating a project calls `projectHooks.postCreate(project, context?)`. The only registered implementation is the no-op default in `project-hooks.ts` — no `ProjectPlan` row, qadam filter, or alert receiver is created.
- Soft-deleted projects remain in DB and can be hard-deleted by a background job
- Deleting a project calls `projectSideEffects.postSoftDelete({ projectId })` (`project/project-side-effects.ts`) from the DELETE route, which drops the project's `alert` rows. The `alert` table has no FK to `project`, and soft-delete would not fire a cascade anyway, so the rows need an explicit sweep.

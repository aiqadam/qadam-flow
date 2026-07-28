# Flow Templates

## Summary
The Templates feature provides a library of reusable flow (and table) blueprints that users can browse, import, and build on. Templates are typed into three categories: OFFICIAL (fetched at request time from `https://flow.aiqadam.org/api/v1/templates` via `communityTemplates`), CUSTOM (platform-owned), and SHARED (one-off sharing URLs, not listable). In this repo the feature is read-only: `template.controller.ts` registers only `GET /:id`, `GET /categories` and `GET /`, and CUSTOM templates are unreachable in both directions — `templateService.create`/`update` throw `Custom platform templates are not supported` for `TemplateType.CUSTOM`, and the list endpoint returns no custom rows because `loadCustomTemplatesOrReturnEmpty` bails when `platform.plan.manageTemplatesEnabled` is false, which the module-local `getPlan()` in `platform.service.ts` hardcodes it to be. Before saving, flows inside a template are validated and piece names extracted into a searchable `pieces` array.

## Key Files
- `packages/server/api/src/app/template/template.controller.ts` — read-only REST controller (get one, list, categories)
- `packages/server/api/src/app/template/template.service.ts` — core CRUD, list filtering, flow validation
- `packages/server/api/src/app/template/template.entity.ts` — TypeORM entity
- `packages/server/api/src/app/template/template-validator.ts` — validates flows and extracts piece names
- `packages/server/api/src/app/template/community-templates.service.ts` — proxies official templates from flow.aiqadam.org
- `packages/shared/src/lib/management/template/template.ts` — `Template`, `TemplateType`, `TemplateStatus`, `FlowVersionTemplate`, `TableTemplate`, `TemplateTag`
- `packages/shared/src/lib/management/template/template.requests.ts` — `CreateTemplateRequestBody`, `UpdateTemplateRequestBody`, `ListTemplatesRequestQuery`
- `packages/web/src/features/templates/api/templates-api.ts` — frontend API client
- `packages/web/src/features/templates/components/templates-browse-dialog.tsx` — browsing/searching dialog
- `packages/web/src/features/templates/components/use-template-dialog.tsx` — importing a template into a project
- `packages/web/src/features/templates/components/share-template.tsx` — sharing a custom template
- `packages/web/src/app/routes/templates/` — public-facing template gallery page

## Domain Terms
- **TemplateType**: `OFFICIAL` (proxied from flow.aiqadam.org), `CUSTOM` (platform-owned — rejected on write, filtered out on read, see Summary), `SHARED` (ad-hoc share, not listable).
- **TemplateStatus**: `PUBLISHED` (visible in listing) or `ARCHIVED` (hidden).
- **FlowVersionTemplate**: A flow version stripped of runtime-only fields (id, flowId, state, etc.) for embedding in a template.
- **TableTemplate**: A table schema (fields, options) embedded in a template for table-related automation blueprints.
- **TemplateTag**: A tag with a `title`, hex `color`, and optional `icon`.
- **pieces**: Denormalized array of piece names extracted from all steps in the template flows; indexed for fast filtering.
- **categories**: Array of string category names; indexed for fast filtering.
- **communityTemplates**: Service that proxies GET requests to `https://flow.aiqadam.org/api/v1/templates` for official templates.

## Entity

**template**
| Column | Type | Notes |
|---|---|---|
| id | string | BaseColumnSchemaPart |
| created | timestamp | BaseColumnSchemaPart |
| updated | timestamp | BaseColumnSchemaPart |
| name | string | |
| summary | string | |
| description | string | |
| type | string | TemplateType enum |
| status | string | TemplateStatus enum |
| platformId | string (nullable) | null for OFFICIAL templates |
| flows | jsonb (nullable) | Array of FlowVersionTemplate |
| tables | jsonb (nullable) | Array of TableTemplate |
| tags | jsonb | Array of TemplateTag |
| blogUrl | string (nullable) | |
| metadata | jsonb (nullable) | |
| author | string | |
| categories | string[] | Postgres text array, indexed |
| pieces | string[] | Postgres text array, indexed |

Indices: `idx_template_pieces`, `idx_template_categories`, `idx_template_platform_id`
Relation: many-to-one with `platform` (CASCADE on delete)

## Endpoints

All routes are prefixed `/v1/templates`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/categories` | public | Returns list of category strings |
| GET | `/:id` | public | Get one template by ID |
| GET | `/` | unscoped (all principals) | List templates (official + custom merged) |

Query params for list: `type`, `pieces[]`, `tags[]`, `search`, `category`.

## Service Methods

**templateService**
- `getOne({ id })` — returns null if not found
- `getOneOrThrow({ id })` — throws ENTITY_NOT_FOUND
- `create({ platformId, params })` — validates flows, extracts pieces, saves OFFICIAL/SHARED rows; throws `VALIDATION` for CUSTOM. No route calls it.
- `update({ id, params })` — re-validates flows if provided; handles OFFICIAL/SHARED only. No route calls it.
- `list({ platformId, pieces, tags, search, type, category })` — queries with ArrayOverlap for pieces, ArrayContains for categories, ILIKE for search. Only returns PUBLISHED templates.
- `delete({ id })` — hard delete

**communityTemplates**
- `list(query)` — proxies to Cloud API with query string forwarding
- `getOrThrow(id)` — proxies single-template fetch to Cloud API
- `getCategories()` — proxies categories endpoint to Cloud API

## Business Logic Notes

- The list endpoint concatenates `loadOfficialTemplatesOrReturnEmpty` (community proxy) with `loadCustomTemplatesOrReturnEmpty` (local DB filtered by `platformId`), and the latter is always empty — see Summary.
- No template can be created, updated or deleted via the API — the controller exposes GET routes only.
- Custom templates listing is skipped silently when `manageTemplatesEnabled` is false — no error is thrown, an empty array is returned (`template.controller.ts`).
- `migrateFlowVersionTemplateList` (`flows/flow-version/migrations/index.ts`) had no caller anywhere in the repo and was removed as dead code.

# Server Backend

Fastify 5 + TypeORM (PostgreSQL) + BullMQ (Redis) + `fastify-type-provider-zod`.

## Tech Stack

- **Framework**: Fastify 5
- **ORM**: TypeORM with PostgreSQL
- **Job Queues**: BullMQ
- **Cache/Redis**: ioredis
- **Observability**: OpenTelemetry
- **Language**: TypeScript (strict)

## Project Structure

- `src/app/` — Feature modules (flows, pieces, tables, authentication, webhooks, etc.)
- `src/app/database/` — Database migrations and connection setup (TypeORM)
- `src/app/helper/` — Shared server utilities

## Patterns

- **Reuse existing endpoints before adding new ones** — Before adding a new endpoint, scan the controller you're working in (and any sibling controllers that handle the same resource) for an existing route that already returns the data you need. Prefer re-using or extending an existing endpoint over introducing a new one. New endpoints duplicate validation, caching, security configuration, docs, and test surface — and parallel endpoints tend to drift (different filters, different cache policies, different response shapes) and cause bugs. Only add a new endpoint when no existing route satisfies the use case.
- **Controllers**: Use `FastifyPluginAsyncTypebox` pattern for route definitions with TypeBox schema validation
- **Module wrappers own the route prefix** — In `app.ts`, every feature is registered as `await app.register(<somethingModule>)` with no inline `prefix` option. The prefix lives inside the module file (e.g. `await app.register(myController, { prefix: '/v1/...' })` inside `my-feature.module.ts`). Never register a controller directly from `app.ts` with an inline prefix — create a thin `*.module.ts` wrapper instead so the route's identity stays collocated with its handlers.
- **HTTP methods**: Use `POST` for all create and update operations — never PUT/PATCH. The single sanctioned exception is `PUT /v1/files/:fileId` in `src/app/file/files-controller.ts`: it is the engine's upload wire protocol (`packages/server/engine/src/lib/engine-file-api.ts`) and matches the S3 signed-URL PUT it redirects to, so it can't move without a lockstep engine change. Don't add a second exception.
- **Database migrations**: Generated and managed via TypeORM
- **Feature modules**: Each module typically has controller, service, and entity files
- **Array columns in TypeORM entities**: Always use this pattern:
  ```ts
  columnName: {
      type: String,
      array: true,
      nullable: false,
  }
  ```

## Running Integration Tests Locally

Integration tests hit a real Postgres + Redis. From the repo root:

```bash
docker compose -f docker-compose.dev.yml up -d postgres redis   # start deps
npm run test-api                                                # check-migrations + test-ce
```

`packages/server/api/.env.tests` is the env file the `test-ce` script sources; it points at `127.0.0.1:5432` (postgres) and `127.0.0.1:6379` (redis) with the credentials baked into `docker-compose.dev.yml`. Tests wipe the DB between files (`TRUNCATE ... CASCADE`), so re-runs are safe.

To run a single file: `cd packages/server/api && export $(cat .env.tests | xargs) && AP_EDITION=ce npx vitest run test/integration/ce/<file>.test.ts`.

Stop deps when done: `docker compose -f docker-compose.dev.yml down` (or `... down -v` to also drop the DB volume).

## Where a Test Belongs

- **Unit** (`vitest`, per-package `test/unit/`) — pure functions, no I/O.
- **Integration** (`packages/server/api/test/integration/{ce,ee}/`) — HTTP handlers + real Postgres + real Redis via `setupTestEnvironment()` + `createTestContext(app)`. Fast (~seconds). This is where invitation flows, permission checks, list filters, and other backend contract tests live.
- **E2E** (`packages/tests-e2e/`) — Playwright driving the real browser. **Only** put a test here if it calls DOM-mutating `page.*` methods (click, fill, select, etc.). See `packages/tests-e2e/AGENTS.md` for the anti-pattern (API-only tests in Playwright) and the environment quirks (single-platform localhost, ungenerated `project_role`).

**Lint applies to tests.** The `api` `lint` script covers `test/**/*.ts`, so test code must pass the same ESLint rules as `src/` (import order, single quotes, no unused vars, no floating promises). Only `no-explicit-any` and `no-dynamic-delete` are relaxed for `test/**/*.ts` (see the override in `packages/server/api/.eslintrc.json`). Run `npm run lint-dev` before finishing.

## Email Templates

Email templates live in `src/assets/emails/`. When creating or modifying email templates, follow these rules:

- **F-pattern layout** — All content (logo, heading, body, notes, fallback link, footer) must be **left-aligned**. The CTA button is auto-width, left-aligned.
- **Design system consistency** — Use the same font scale as the web app: Inter font family, 32px/500 headings, 16px body, 14px closing, 11px muted text. Colors: `#0a0a0a` headings, `#2f2e2e` body, `#a3a3a3` muted.
- **White-label ready** — Use `{{fullLogoUrl}}`, `{{primaryColor}}`, `{{primaryColorLight}}`, and `{{platformName}}` Mustache variables. Never hardcode "Activepieces" or brand colors.
- **Card-on-background layout** — White card (`560px`, `border-radius: 12px`) on `{{primaryColorLight}}` tinted background.
- **CTA button** — Auto-width, left-aligned, `{{primaryColor}}` background, 16px/500 white text, `12px 18px` padding, `8px` border-radius.
- **Fallback link** — Below the CTA: "If the button doesn't work, click here." at 11px `#a3a3a3`, with `click here` underlined in `{{primaryColor}}`.
- **Bold sparingly in body** — Only bold dynamic names the user needs to identify quickly (project name, role, flow name). Never bold static text.
- **Outlook compatibility** — Include `<!--[if mso]>` font-family override block. Use table-based layout with inline styles only.
- **No external dependencies** — No `<link>` stylesheets, no tracking pixels, no external font CSS. The `@font-face` CDN URLs in `<style>` are acceptable as progressive enhancement.
- **Footer** — Use `{{> footer}}` Mustache partial. It renders the address only on Cloud edition.

## N+1 Query Prevention

- **Never fetch a collection then query each item individually in a loop.** Use JOINs, subqueries, or `IN` clauses to push filtering and enrichment into a single query.
- When checking a condition across related rows (e.g. "does any membership have permission X?"), JOIN the related table and filter in SQL rather than loading all rows and filtering in JS.
- For list endpoints that enrich entities with related data, prefer `leftJoinAndSelect` / `innerJoin` or batch queries with `IN (:...ids)` over per-item lookups inside `Promise.all` / `.map()`.

## Guidelines

- Read existing code before making changes to understand patterns
- Follow the existing controller/service pattern when adding new endpoints
- Write database migrations for schema changes, never modify entities directly without a migration . use db-migration skill
- No Enterprise Edition code exists in this repo. All features are available to all users.

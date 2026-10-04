# Server Backend

Fastify 5 + TypeORM (PostgreSQL) + BullMQ (Redis) + `fastify-type-provider-zod`.

## Skills and agents for this package

Mandatory when the trigger matches — full registry in [`.agents/rules/skill-usage.md`](../../.agents/rules/skill-usage.md):

| Doing | Read first |
| --- | --- |
| A new route or HTTP handler | `add-endpoint` skill |
| A new TypeORM entity | `add-entity` skill |
| Any schema change | `db-migration` skill |
| Work spanning shared + server + web | `add-feature` skill |
| An MCP server change | `mcp-builder` skill |

Implementation can be delegated to the `server` agent. The `code-quality` agent and the
`app-sec` agent are both mandatory on **every** change in this package before you report it
complete —
see [`.agents/rules/agent-delegation.md`](../../.agents/rules/agent-delegation.md).

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
- **List limits are bounded** — `buildPaginator` rejects a negative or non-integer `limit` and clamps anything above `MAX_PAGE_SIZE` (1000).
  - `0` skips the limit, so the paginator returns its own default page of 100. A controller's `?? DEFAULT_PAGE_SIZE` does not apply to it. This keeps the pre-#561 behaviour published clients still rely on.
  - A list DTO's `limit` is `z.coerce.number().int().min(0)`, or tighter where a DTO already rejected 0 before #561 (translations, alerts, chat conversations, API keys).
  - A computed limit that can reach 0 is a bug: it gets 100 rows, not zero.
  - On `GET /v1/records`, `0` reads the whole table, as `qadam-tables` means it (#573).
  - Server code that needs every row passes `unlimited: true`. Never pass a huge number or the old `-1` magic value to mean "all" (#561).
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

To run a single file: `cd packages/server/api && export $(cat .env.tests | xargs) && npx vitest run test/integration/ce/<file>.test.ts`.

Stop deps when done: `docker compose -f docker-compose.dev.yml down` (or `... down -v` to also drop the DB volume).

The dev `redis` service runs Valkey 8.1 (#612), which saves RDB format 11. A branch from before #612 still pins `redis:7.0.7`, and that image restarts in a loop on a volume Valkey has written to (`Can't handle RDB format version 11`). The same goes for the devcontainer's `redis_data`. Before running `up` on such a branch, drop the Redis volume: `docker compose -f docker-compose.dev.yml down`, then `docker volume rm <project>_redis_data_dev` (`docker volume ls | grep redis_data` shows the name). Redis holds only queue and cache state, so the Postgres data is unaffected.

The dev `postgres` service runs PostgreSQL 18 (#611) on a new `pgdata_dev` volume, so the first `up` after #611 starts from an empty cluster: `tools/postgres-init` creates `qadam_flow_dev` and `qadam_flow_test` again and the migrations rebuild the schema. Your PostgreSQL 14 dev data stays in `postgres_data_dev`, which a branch from before #611 still mounts, so switching between old and new branches works in both directions. To carry that data over, dump it with the old image (`docker run --rm -d --name pg14-dev -v <project>_postgres_data_dev:/var/lib/postgresql/data pgvector/pgvector:0.8.0-pg14`, wait until `docker exec pg14-dev pg_isready -h 127.0.0.1` reports `accepting connections`, then `docker exec pg14-dev pg_dump -U postgres -Fc -d qadam_flow_dev > dev.dump`) and restore it with `docker exec -i qadam-flow-postgres-dev pg_restore -U postgres --clean --if-exists -d qadam_flow_dev < dev.dump`. The devcontainer's `db` service moved the same way, from `postgres_data` to `pgdata`.

## Where a Test Belongs

- **Unit** (`vitest`, per-package `test/unit/`) — pure functions, no I/O.
- **Integration** (`packages/server/api/test/integration/{ce,ee}/`) — HTTP handlers + real Postgres + real Redis via `setupTestEnvironment()` + `createTestContext(app)`. Fast (~seconds). This is where invitation flows, permission checks, list filters, and other backend contract tests live.
- **E2E** (`packages/tests-e2e/`) — Playwright driving the real browser. **Only** put a test here if it calls DOM-mutating `page.*` methods (click, fill, select, etc.). See `packages/tests-e2e/AGENTS.md` for the anti-pattern (API-only tests in Playwright) and the environment quirks (single-platform localhost, ungenerated `project_role`).

**Lint applies to tests.** The `api` `lint` script covers `test/**/*.ts`, so test code must pass the same ESLint rules as `src/` (import order, single quotes, no unused vars, no floating promises). Only `no-explicit-any` and `no-dynamic-delete` are relaxed for `test/**/*.ts` (see `serverConfigs.api` in `tools/eslint/server.mjs`). Run `npm run lint-dev` before finishing.

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
- **Footer** — Use the shared `footer.html` partial via `{{> footer}}`. It sits flat in the emails directory (no `partials/` subfolder) and is registered globally by `smtp-email-sender.ts`; it renders `{{footerContent}}` only when the template's vars provide it.

## N+1 Query Prevention

- **Never fetch a collection then query each item individually in a loop.** Use JOINs, subqueries, or `IN` clauses to push filtering and enrichment into a single query.
- When checking a condition across related rows (e.g. "does any membership have permission X?"), JOIN the related table and filter in SQL rather than loading all rows and filtering in JS.
- For list endpoints that enrich entities with related data, prefer `leftJoinAndSelect` / `innerJoin` or batch queries with `IN (:...ids)` over per-item lookups inside `Promise.all` / `.map()`.

## Guidelines

- Read existing code before making changes to understand patterns
- Follow the existing controller/service pattern when adding new endpoints
- Write database migrations for schema changes; never modify entities directly without one — follow the `db-migration` skill
- No Enterprise Edition code exists in this repo. All features are available to all users.

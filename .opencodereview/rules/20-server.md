# Server conventions

Scope: `packages/server/**`. Source: root `AGENTS.md` and `.agents/rules/*`.

## Tenant isolation (critical)

<!-- repo-wide:start -->
Source: root `AGENTS.md`. These apply to every TypeScript file, in addition to
the language rules OCR already merges from its system layer.

- **No `any`.** Use a precise type, or `unknown` plus a type guard.
- **No type casting.** Do not use `as SomeType` to force a type. If you touch a
  line with an unnecessary cast, removing it is part of the change.
- **No deprecated APIs.** If a used method or export carries a `@deprecated`
  JSDoc tag, it must be replaced with the recommended one.
- **Error handling.** Prefer `tryCatch` / `tryCatchSync` from `@aiqadam/shared`
  (Go-style `{ data, error }`) over `try`/`catch` in server code.
- **Named parameters.** Every function with more than one parameter takes a
  single destructured object. Positional arguments are a finding.
- **Immutable data flow.** A function must return new collections instead of
  mutating a caller-owned array or object. Local mutation inside one function
  body is fine.
- **File order.** imports → exported constants → exported functions → helpers →
  types at the end of the file. A type declared before the code that uses it is
  a finding (paired zod schemas and a small local type above its only consumer
  are the sanctioned exceptions).
- **Comments explain *why*.** Comments that restate *what* the code does are
  noise and a finding.
- **Util files.** Multiple plain functions in one util file are grouped into a
  single exported `const` object; callers use `myUtils.fn1()`. React components
  are named exports instead.
- **Shared package versioning.** Any change under `packages/shared` must bump
  the version in `packages/shared/package.json`: patch for fixes or
  non-breaking additions, minor for new exports or behaviour changes. A
  `packages/shared` diff without a version bump is a finding (note the diff may
  put the two files in different review groups — check the changeset, not just
  this file).
- **Agent knowledge lives in `.agents/`.** `.claude/` and `.cursor/` are
  git-symlink mirrors; editing a mirror instead of `.agents/` is a finding.
<!-- repo-wide:end -->

- **Every** database query MUST be scoped by `projectId` or `platformId`. A
  query — or a controller/service call chain that reaches one — without a
  tenant filter is a critical finding.
- Connections with multi-project access filter with
  `ArrayContains([projectId])` on the `projectIds` array column.

## HTTP endpoints

- Every route declares a `securityAccess` config. A new endpoint without one is
  a finding.
- `POST` for create/update mutations, `DELETE` for deletes. `PUT` and `PATCH`
  are forbidden. The only sanctioned exception is `PUT /v1/files/:fileId` in
  `packages/server/api/src/app/file/files-controller.ts` (the engine's
  file-upload wire protocol) — do not accept a second exception.

## Outbound HTTP (SSRF)

- Use `safeHttp.axios` / `safeHttp.createAxios(...)` from
  `@aiqadam/server-utils` for URLs that come from user input, admin config,
  OAuth endpoints, or third-party integrations; `safeHttp.fetch` when a library
  takes only a `fetch` override.
- Raw `fetch` or `axios.create` for those URLs is a finding: it bypasses the
  private/loopback/metadata-IP filter.

## Side effects and atomicity

- Business side effects live in `*-side-effects.ts` and are called explicitly
  after the mutation.
- Effects that must commit atomically with the mutation are registered as hooks
  (`*-hooks.ts`) and invoked inside the mutation's own transaction — invoking
  one directly from a controller is a finding.

## Entities and edition safety

- A new TypeORM entity MUST be added to `getEntities()` in
  `packages/server/api/src/app/database/database-connection.ts`; TypeORM does
  NOT auto-discover. An entity file not registered there is a finding.
- There is no Enterprise Edition in this repo. Edition gating, paywalls,
  `ee/` directories, or EE-only services are findings: all features ship as CE.

## Concurrency and data safety

- Multi-server mutations use `distributedLock`, BullMQ deduplication, or
  `FOR UPDATE SKIP LOCKED`. A read-modify-write without one of these is a
  finding.
- External/untrusted data written to PostgreSQL goes through
  `sanitizeObjectForPostgresql()`. No custom PostgreSQL extensions.
- Environment: `AP_ENVIRONMENT` is `prod` / `dev` / `test`. Using `TESTING`
  where `ApEnvironment` is meant is a finding (it silently disables every
  `environment === ApEnvironment.TESTING` branch).

## Validation messages

- Every Zod `.min()`, `.refine()`, `.superRefine()` and similar that surfaces a
  user-facing message must pass a string that exists as a key in
  `packages/web/public/locales/en/translation.json`; use the `formErrors`
  constant from `@aiqadam/shared` for common messages. Raw English sentences
  are a finding.

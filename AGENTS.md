# Qadam Flow

Open-source AI-first workflow automation platform. Self-hosted by
design. 238 qadams (27 core + 211 community). MCP support.

End users install via `curl -fsSL https://flow.aiqadam.org/run.sh | sh`
(POSIX script in repo root). The script downloads `docker-compose.yml`,
generates a fresh `.env`, pulls `ghcr.io/aiqadam/qadam-flow:latest`, and
brings the stack up on port 8080. Don't reintroduce `start.sh` — its job
is covered by `run.sh` plus plain `docker compose` commands.

## Architecture (Non-Obvious Rules)

- **Multi-tenant**: Platform → Projects → Users. ALL queries MUST filter by `projectId` or `platformId`.
- **No EE code in this repo**: All features run as CE. Never reintroduce edition gating, paywalls, or EE-only services. Never create an `ee/` directory.
- **Entity registration**: New entities MUST be added to `getEntities()` in `database-connection.ts` — TypeORM does NOT auto-discover.
- **HTTP**: `POST` for all create/update mutations. `DELETE` for deletes. Never PUT/PATCH. One sanctioned exception: `PUT /v1/files/:fileId` in `packages/server/api/src/app/file/files-controller.ts` — it is the engine's file-upload wire protocol (`packages/server/engine/src/lib/engine-file-api.ts`) and the method the S3 signed-URL redirect it falls through to also requires, so changing it means a lockstep server+engine break for no user-visible gain. Don't add a second exception.
- **Security**: Every endpoint needs `securityAccess` config.
- **Side effects**: Separated into `*-side-effects.ts` files, called explicitly after mutations — except effects that must commit atomically with the mutation: those are registered as hooks (`*-hooks.ts`) and invoked inside the mutation's own transaction, never from a controller.
- **Multi-server**: Use `distributedLock`, BullMQ deduplication, or `FOR UPDATE SKIP LOCKED` for concurrent operations.
- **Managed PostgreSQL**: No custom extensions. Use `sanitizeObjectForPostgresql()` for external data.
- **Before modifying a module**: Read its `.agents/features/<name>.md` file for entities, services, and integration details.
| `.agents/features/*.md` | ~60 lines each | When Claude explores the feature | Entity schemas, services, data flows |
| `.claude/rules/` | 3-5 lines each | Every session | Critical safety checks (entity registration, data isolation, edition safety) |
| `.agents/skills/` | 30-65 lines each | When invoked | Step-by-step workflows (`/add-feature`, `/add-entity`, `/add-endpoint`, `/qadam-builder`) |
| `.claude/agents/` | 40-70 lines each | When delegating | Subagent charters (`server`, `web`, `changelog`, `code-quality`, `app-sec`) |
- **Exported types and constants must be placed at the end of the file**, after all logic (functions, hooks, components, classes, etc.). This keeps the logic front and centre when reading a file, and groups the public contract at a predictable location.

  ```ts
  // ✅ Correct
  function doSomething() { ... }

  export const MY_CONST = 'value';
  export type MyType = { ... };
  // ✅ Correct
  const businessService = () => { ... }

  export const MY_CONST = 'value';
  export type MyType = { ... };

  // ❌ Wrong — types/consts mixed in before logic
  export const MY_CONST = 'value';
  export type MyType = { ... };
  function doSomething() { ... }
  ```

## Coding Conventions

- **No `any` type** — Use proper type definitions or `unknown` with type guards
- **No type casting** — Do not use `as SomeType` to force types. If you encounter an unnecessary cast, remove it.
- **No deprecated APIs** — Before using any library method or export, check its JSDoc. If it carries a `@deprecated` tag, use the recommended replacement instead. Examples: prefer `z.enum` over `z.nativeEnum`.
- **Go-style error handling** — Use `tryCatch` / `tryCatchSync` from `@aiqadam/shared`
- **Zod error messages must be i18n keys** — Every `.min()`, `.refine()`, `.superRefine()`, etc. that surfaces a user-facing message must pass a string that exists as a key in `packages/web/public/locales/en/translation.json`. For common messages (e.g. required fields) use the `formErrors` constant from `@aiqadam/shared`. Add a new translation key if none fits; never use raw English sentences that are not in the translation file.
- **`@aiqadam/shared` version bump** — Any change to `packages/shared` must be accompanied by a version bump in `packages/shared/package.json`: bump the **patch** version for non-breaking additions or fixes, bump the **minor** version for new exports or behaviour changes after you check if it has already been bumped in the current branch or not
- **Helper functions** — Define non-exported helpers outside of const declarations
- **Named parameters** — Always use a single destructured object parameter instead of positional arguments. This applies to every function with more than one parameter, regardless of type. It prevents mix-ups at the call site and makes future additions non-breaking.
- **Prefer immutable data flow** — Functions should produce data by returning it, not by mutating an array/object the caller passes in. If a helper accumulates results (logs, derived rows, computed bindings), it should build the collection locally and return it — not take a pre-allocated bag the caller will read after. Local mutation inside a function's own body is fine; mutation that crosses the function boundary is not. Build new collections with `.map` / `.filter` / `.reduce` / spread rather than in-place `push` / `splice` / property assignment when feasible.
- **File order**: Imports → Exported functions/constants → Helper functions → Types
- **Comments** — Only comment to explain *why* something is done, never *what* the code is doing. Code should be self-explanatory; comments that restate the code add noise and rot.
- **Util file exports** — When a util file exposes multiple plain functions or constants (non-React), do not export them individually. Instead, group them into a single named `const` and export that one object (e.g. `export const myUtils = { fn1, fn2 }`). Callers use `myUtils.fn1()` at the call site. **React components** in the same file should be **named exports** (e.g. `export function MyAlert()` or `export const MyAlert = …`) and imported by name — do not bundle them into a wrapper object for the sake of this rule.
- **Safe outbound HTTP (SSRF)** — For any outbound HTTP in `packages/server/{api,worker,utils}`, use `safeHttp.axios` / `safeHttp.createAxios({ ... })` from `@aiqadam/server-utils`. Never use raw `fetch` or `axios.create` for URLs that come from user input, admin config, OAuth endpoints, or third-party integrations — they bypass the SSRF filter (private/loopback/metadata IPs). See `.claude/rules/safe-http.md`.

## Query Error Handling

- **Global error dialog via `meta`** — `app.tsx` has a `QueryCache.onError` handler that shows an error dialog when `query.meta?.showErrorDialog` is truthy. When adding a new `useQuery` that fetches primary page data (e.g. table rows, list data), add `meta: { showErrorDialog: true }` to the query options.
- **Do NOT add** `showErrorDialog` to minor/auxiliary queries (feature flags, qadam metadata, single-item fetches, filter options, user details). These should fail silently.
- Rule of thumb: if the query failure would leave the user staring at an empty table or blank page with no explanation, it should have `meta: { showErrorDialog: true }`.

## Key Utilities (`@aiqadam/shared`)

`apId()`, `tryCatch()`, `tryCatchSync()`, `isNil()`, `spreadIfDefined()`, `spreadIfNotUndefined()`, `QadamFlowError({ code, params })`, `SeekPage<T>`, `formErrors`, `BaseModelSchema`, `chunk()`, `partition()`, `unique()`, `omit()`, `sanitizeObjectForPostgresql()`

## Testing

```bash
npm run test-unit     # Vitest: engine + shared + web + server-utils
npm run test-api      # API integration (CE, EE, Cloud)
```
API tests: `setupTestEnvironment()` + `createTestContext(app)` → `ctx.post()`, `ctx.get()`. DB auto-cleaned between tests.

- **`AP_ENVIRONMENT` valid values are `prod` / `dev` / `test`** (the `ApEnvironment` enum). The test env is `test`, NOT `TESTING`. Beware the footgun: `ApEnvironment.TESTING === 'test'` but the unrelated `RunEnvironment.TESTING === 'TESTING'` — using `TESTING` for `AP_ENVIRONMENT` silently disables every `environment === ApEnvironment.TESTING` branch. Startup now throws on an invalid value. See `.claude/rules/environment.md`.
- CE integration tests share one Postgres DB, so they must run serially — `test-ce-command` passes `--no-file-parallelism`. Don't re-enable file parallelism for `test/integration`.
- **Test files are linted too.** The `api` package's `lint` script covers `test/**/*.ts` as well as `src/`, and the `CE Integration Tests` / `Lint + Unit Tests` CI jobs enforce it — so `test/` code must satisfy the same ESLint rules as `src/` (import order, single quotes, no unused vars, no floating promises, …). Two rules are relaxed for `test/**/*.ts` only, via an override in `packages/server/api/.eslintrc.json`: `no-explicit-any` and `no-dynamic-delete` (tests legitimately poke internals and build negative fixtures). Run `npm run lint-dev` before finishing — it auto-fixes most test-lint issues.

## Commands

This monorepo uses **turbo** (see `turbo.json`) as the task runner and **bun** as the package manager (see `packageManager` in `package.json`). There is no Nx — never invoke `nx` or `npx nx`.

Install dependencies with `bun install`. `npm install` will fail with `TypeError: Cannot read properties of null (reading 'matches')` in npm's arborist during dedup. The `npm run <script>` entries below still work because they only delegate to turbo — but the initial install must be bun.

```bash
bun install                                     # Install deps (required — npm install fails)
npm start                                       # Setup dev + start all
npm run dev                                     # Frontend + backend
npm run lint-dev                                # Lint with auto-fix (ALWAYS before done)
npx turbo run lint --filter=<package>           # Lint a single package, e.g. --filter=web
npx turbo run serve --filter=web -- --mode=cloud # Run local frontend against the cloud backend
```

When running in `--mode=cloud`, do not use OAuth2 connections — the OAuth provider will redirect back to `flow.aiqadam.org` after sign-in instead of your local frontend, breaking the flow. Use API-key / basic-auth connections, or test OAuth2 against a fully local backend.

## Git Commits (DCO)

- **Every commit must be signed off under the Developer Certificate of Origin.** Always commit with `git commit -s` (`--signoff`) so a `Signed-off-by: <name> <email>` trailer (taken from `user.name`/`user.email`) is added. This is required by [GOVERNANCE.md](./GOVERNANCE.md) / [CONTRIBUTING.md](./CONTRIBUTING.md) — PRs with un-signed-off commits can't be merged. Keep the `Co-Authored-By:` trailer as well; both trailers belong at the end of the message.

## Git Push

- Always prefix `git push` with `CLAUDE_PUSH=yes` to auto-approve the pre-push lint/test gate, e.g. `CLAUDE_PUSH=yes git push -u origin HEAD`.

## Pull Requests

- When creating a PR with `gh pr create`, always apply exactly one of these labels based on the nature of the change:
  - **`feature`** — new functionality
  - **`bug`** — bug fix
  - **`skip-changelog`** — changes that should not appear in the changelog (docs, CI tweaks, internal refactors, etc.)
- If the PR includes any contributions to qadams (integrations under `packages/qadams`), also add the appropriate qadams label (in addition to the primary label above):
  - **`area/third-party-qadams`** — for third-party integrations (most qadams under `packages/qadams/community/`)
  - **`area/core-qadams`** — for core qadams (under `packages/qadams/core/`)

## Database Migrations

- Before creating or modifying a database migration, **always read `.agents/skills/db-migration/SKILL.md`** first. Follow its instructions for generating and structuring migrations.

## Verification

- Always run `npm run lint-dev` as part of any verification step before considering a task complete.

### Commands that look like verification but verify nothing

These have each produced a confident "verified, clean" claim that was worthless. Check the command
before trusting its silence — an empty output is not the same as a passing check.

- **`tsc --noEmit -p packages/server/api`** type-checks **zero files**. That `tsconfig.json` has
  `"files": []`, `"include": []` and only project `references`, and non-build-mode `tsc -p` does not
  follow references. It exits 0 and prints nothing on any input. Confirm with `--listFiles`.
  Use `tsc --noEmit -p packages/server/api/tsconfig.app.json` or `tsc -b packages/server/api`.
- **`tsc` on the api package without built workspace deps** reports ~1600 pre-existing
  `Cannot find module '@aiqadam/...'` errors. In an environment where `bun install` has not run,
  local type-checking of that package proves nothing either way; CI is the authoritative signal.
  Say so rather than substituting a command that returns clean.
- **A package missing the script turbo is asked to run silently checks nothing.** `turbo run lint
  --filter=X` on a package with no `lint` script is a no-op that still reports success — this is how
  `packages/server/utils` went unlinted while appearing in `lint-core` (fixed in #148). Before
  trusting a filter, confirm the target package actually declares the script.
- **A skipped required check never reports a conclusion.** Under the repo ruleset
  (`strict_required_status_checks_policy: true`), a required context that is skipped via
  `paths-ignore` or a job-level `if:` leaves the PR permanently unmergeable. A required job must
  always run and always resolve, even when it short-circuits.
- **Empty check conclusions read as pending, not passing.** `gh pr view --json statusCheckRollup`
  returns `""` (not `null`) for an in-flight check. Treat any falsy conclusion as pending, or you
  will read a running pipeline as green.

## Review Agents

Two read-only reviewer subagents live in `.claude/agents/`. Their charters are the source of truth —
read the file, don't paraphrase it from here.

| Agent | Use it for |
| --- | --- |
| `code-quality` | Correctness, project-convention violations, dead code left by a removal, missing test coverage, and PR-body claims the diff does not support |
| `app-sec` | Tenant isolation, authz, SSRF, injection, secret handling, migration hazards on existing deployments, edition/licensing safety |

- **Review before merging anything that touches server code, auth, migrations, or outbound HTTP** —
  run both, and treat a `DO NOT MERGE` verdict as blocking.
- **Use a different agent than the one that wrote the code.** An author reviewing its own work
  reproduces its own blind spots; the point of the second pass is an independent reading.
- Both are read-only by charter. A reviewer that edits code stops being a reviewer.
- Reviewers must verify claims against the code, not against the PR description. The failure mode
  worth guarding against is a confident assertion resting on the wrong file or a same-named-but-
  different symbol — that is how wrong work gets approved.

## White-Labeling & Edition Paths

- **All customer-facing UI must be white-labeled.** Sign-in/signup pages, email templates, logos, and any user-visible branding must use the platform's configured appearance (name, colors, logos) — never hardcode "Activepieces" in user-facing surfaces.
- **Never copy upstream EE source — clean-room reimplement instead.** Upstream `packages/ee/` (and `packages/server/api/src/app/ee`) is under the proprietary Activepieces Enterprise License, not MIT; this repo is MIT-only. When restoring a feature that lived under upstream `ee/` (API keys, SSO, RBAC, audit logs, git sync), NEVER copy the EE source verbatim (no `git show <upstream-sha>:packages/ee/...`, no pasting bodies/structure) — that infringes the Enterprise License. Reimplement from behavior only (HTTP contract, schema-as-idea, auth flow); copyright protects the specific source, not the functionality or API. Code already in the MIT core is safe to reuse. See `.claude/rules/edition-safety.md`.

## Useful Links

- [Database Migrations Playbook](.agents/skills/db-migration/SKILL.md)

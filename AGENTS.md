# Qadam Flow

Open-source AI-first workflow automation platform. Self-hosted by
design. 238 qadams (27 core + 211 community). MCP support.

End users install via `curl -fsSL https://flow.aiqadam.org/run.sh | sh`
(POSIX script in repo root). The script downloads `docker-compose.yml`,
generates a fresh `.env`, pulls `ghcr.io/aiqadam/qadam-flow:latest`, and
brings the stack up on port 8080. Don't reintroduce `start.sh` — its job
is covered by `run.sh` plus plain `docker compose` commands.

## Read the whole ticket before you write a line — this is not optional

**The issue body is the least reliable part of an issue.** It was written before
anyone investigated. The comments are where the measurements, the corrections and the
already-rejected approaches live, and a closed PR is where the reason something was
*not* done is recorded. Skipping them does not save time; it spends a whole work
session reproducing an answer the repo already had.

This has happened. #155's body proposed caching `~/.bun/install/cache`. That exact
change had already been written, measured on real runners and **closed as a net
regression** in PR #157 — and a local branch `ci/issue-155-cache-bun-deps` was still
sitting in the repo with the same diff. It was rebuilt from scratch anyway, opened as
PR #191, and came within one review of merging a step that costs 18 s and saves 7 s.
Cause: only the issue body was read.

Before touching anything, run all of these and actually read the output:

```bash
gh issue view <n> --comments                       # the body is the hypothesis; comments are the evidence
gh pr list --state all --search "<n> in:title,body" # closed PRs say why an approach was rejected
gh issue list --state all --search "<keyword>"      # a sibling issue may already own this
git branch -a --list '*<n>*'; git worktree list     # someone may already have a tree for it
```

Then follow the links. Every issue number, PR number, run URL and commit SHA mentioned
in the body **or in any comment** is context someone paid for. Open them. A referenced
CI run has the timings that settle a performance claim; a referenced closed PR has the
verdict. If a comment contradicts the body, the comment is newer and probably right —
and say so explicitly in your PR rather than silently following one of them.

If a ticket turns out to rest on a wrong premise, correct the ticket in a comment
before writing code against it. That is not scope creep; it is the cheapest work in
the whole session.

## Agent knowledge map — single source: `.agents/`

All agent-facing knowledge lives under `.agents/`. `.claude/` and `.cursor/`
mirror parts of it via git symlinks so each harness's auto-discovery keeps
working — never edit a mirror; add content under `.agents/` only.

| Path | Size | When | What |
| --- | --- | --- | --- |
| `AGENTS.md` (this file) + per-package `AGENTS.md` | — | Every session | Rules every task needs |
| `.agents/features/*.md` | 35–221 lines each | Before modifying a module | Entity schemas, services, data flows |
| `.agents/rules/*.md` | 2–15 lines each (the mintlify writing rule is ~400) | Every session | Critical safety checks (entity registration, data isolation, edition safety, safe HTTP, environment) |
| `.agents/skills/*/SKILL.md` | 12–1100 lines each | When invoked | Step-by-step workflows (`add-feature`, `add-entity`, `add-endpoint`, `db-migration`, `qadam-builder`) |
| `.agents/agents/*.md` | 25–65 lines each | When delegating | Subagent charters (`server`, `web`, `changelog`, `code-quality`, `app-sec`) |
| `.agents/docs/*.md` | deep dives | On trigger (see [Verification](#verification)) | Verification pitfalls, CI node_modules cache |

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
- **File order**: Imports → Exported functions/constants → Helper functions → Types. **Types (exported or not) go at the end of the file**, after all logic — the public type contract sits in one predictable place. **Exported constants go at the top**, right after imports: the namespace-const pattern (services, utils, repos) is the file's table of contents, not something to bury at the bottom (server canon: [STYLE.md](packages/server/STYLE.md)).
- **Sanctioned file-order exceptions** (audit across the monorepo, do not stretch them): a zod schema's `z.infer` type may sit adjacent to its schema (paired or grouped with sibling schemas); a small local type may sit directly above its only consumer; a trailing enum after a type block is fine in shared domain files. These are idioms the codebase uses deliberately — they are not license to move types wholesale back up a file.

  ```ts
  // imports
  import { isNil } from '@aiqadam/shared'

  // exported namespace / constants — top, after imports
  export const flowService = (log: FastifyBaseLogger) => ({ /* ... */ })

  // helpers — unexported
  const lockFlowVersionIfNotLocked = async ({ /* ... */ }) => { /* ... */ }

  // types — end of file
  export type CreateParams = { projectId: ProjectId; /* ... */ }
  ```
- **Comments** — Only comment to explain *why* something is done, never *what* the code is doing. Code should be self-explanatory; comments that restate the code add noise and rot.
- **Util file exports** — When a util file exposes multiple plain functions or constants (non-React), do not export them individually. Instead, group them into a single named `const` and export that one object (e.g. `export const myUtils = { fn1, fn2 }`). Callers use `myUtils.fn1()` at the call site. **React components** in the same file should be **named exports** (e.g. `export function MyAlert()` or `export const MyAlert = …`) and imported by name — do not bundle them into a wrapper object for the sake of this rule.
- **Safe outbound HTTP (SSRF)** — For any outbound HTTP in `packages/server/{api,worker,utils}`, use `safeHttp.axios` / `safeHttp.createAxios({ ... })` from `@aiqadam/server-utils`, or `safeHttp.fetch` when a library takes a `fetch` override and nothing else. Never use raw `fetch` or `axios.create` for URLs that come from user input, admin config, OAuth endpoints, or third-party integrations — they bypass the SSRF filter (private/loopback/metadata IPs). See `.agents/rules/safe-http.md`.
- **i18n keys are four-locale by definition** — a key added to `packages/web/public/locales/en/translation.json` needs an actual `ru`/`uz`/`kk` translation in the same PR. `npm run check-i18n` enforces key parity, non-empty values, ICU-argument preservation and exact key sets (`--fix` prunes stale keys); `tools/ci/i18n-allowlist.json` records the deliberate exceptions. See [docs/about/i18n.mdx](docs/about/i18n.mdx).

## Query Error Handling

- **Global error dialog via `meta`** — `app.tsx` has a `QueryCache.onError` handler that shows an error dialog when `query.meta?.showErrorDialog` is truthy. When adding a new `useQuery` that fetches primary page data (e.g. table rows, list data), add `meta: { showErrorDialog: true }` to the query options.
- **Do NOT add** `showErrorDialog` to minor/auxiliary queries (feature flags, qadam metadata, single-item fetches, filter options, user details). These should fail silently.
- Rule of thumb: if the query failure would leave the user staring at an empty table or blank page with no explanation, it should have `meta: { showErrorDialog: true }`.

## Key Utilities (`@aiqadam/shared`)

`apId()`, `tryCatch()`, `tryCatchSync()`, `isNil()`, `spreadIfDefined()`, `spreadIfNotUndefined()`, `QadamFlowError({ code, params })`, `SeekPage<T>`, `formErrors`, `BaseModelSchema`, `chunk()`, `partition()`, `unique()`, `omit()`, `sanitizeObjectForPostgresql()`

## Testing

```bash
npm run test-unit     # Vitest, unfiltered: `turbo run test` — every package declaring a `test` script
npm run test-api      # CE API integration + migration check (this repo has no EE or Cloud suite)
```
API tests: `setupTestEnvironment()` + `createTestContext(app)` → `ctx.post()`, `ctx.get()`. DB auto-cleaned between tests.

- **`AP_ENVIRONMENT` valid values are `prod` / `dev` / `test`** (the `ApEnvironment` enum). The test env is `test`, NOT `TESTING`. Beware the footgun: `ApEnvironment.TESTING === 'test'` but the unrelated `RunEnvironment.TESTING === 'TESTING'` — using `TESTING` for `AP_ENVIRONMENT` silently disables every `environment === ApEnvironment.TESTING` branch. Startup now throws on an invalid value. See `.agents/rules/environment.md`.
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
npm run review                                  # Advisory AI review against .opencodereview/rule.json
npx turbo run lint --filter=<package>           # Lint a single package, e.g. --filter=web
npx turbo run serve --filter=web -- --mode=cloud # Run local frontend against the cloud backend
```

When running in `--mode=cloud`, do not use OAuth2 connections — the OAuth provider will redirect back to `flow.aiqadam.org` after sign-in instead of your local frontend, breaking the flow. Use API-key / basic-auth connections, or test OAuth2 against a fully local backend.

`npm run review` is advisory and opt-in: it never runs as part of lint/tests and never blocks by itself. It wraps [alibaba/open-code-review](https://github.com/alibaba/open-code-review) (the `ocr` CLI) — failure points, delegation and the `[r]eview` hook shape are in [CONTRIBUTING.md](./CONTRIBUTING.md). `.opencodereview/rule.json` encodes the conventions in this file for the reviewer — when a convention here changes, update the matching file under `.opencodereview/rules/`.

## Git Commits (DCO)

- **Every commit must be signed off under the Developer Certificate of Origin.** Always commit with `git commit -s` (`--signoff`) so a `Signed-off-by: <name> <email>` trailer (taken from `user.name`/`user.email`) is added. This is required by [GOVERNANCE.md](./GOVERNANCE.md) / [CONTRIBUTING.md](./CONTRIBUTING.md) — PRs with un-signed-off commits can't be merged. Keep the `Co-Authored-By:` trailer as well; both trailers belong at the end of the message.
- **The trailers must sit in one final block with no blank line between them.** Git treats only the
  *last paragraph* as the trailer block, and the `DCO Sign-off` job reads sign-offs with
  `git show -s --format='%(trailers:key=Signed-off-by,valueonly)'` (`.github/workflows/ci.yml`).
  So a message ending in `Signed-off-by:`, blank line, `Co-Authored-By:` has **no** parsed sign-off
  and fails the required check, even though the line is plainly visible in `git log`. Correct shape:

  ```
  Closes #123

  Signed-off-by: Name <email>
  Co-Authored-By: <agent or model that wrote the code> <contact>
  ```

  (The `Co-Authored-By` trailer is harness-specific — keep whatever your harness/model adds, e.g.
  `Co-Authored-By: opencode (GLM) <noreply@example.com>`. No hardcoded brand belongs in the
  template.)

  Verify before pushing, don't eyeball the message — and check the whole branch, not just `HEAD`,
  because the job checks every non-merge commit in the PR:
  `git log --no-merges --format='%h %an <%ae> | %(trailers:key=Signed-off-by,valueonly)' origin/main..HEAD`.
  Keep `--no-merges` — the job passes it too, so an unsigned merge commit from a branch update is
  not a failure and must not be treated as one.
  Every line must show the sign-off matching that commit's own author; a blank right-hand side is
  the failure.

## Git Push

- Always prefix `git push` with `RUN_CHECKS=yes` to auto-approve the pre-push lint/test gate, e.g.
  `RUN_CHECKS=yes git push -u origin HEAD`. (`RUN_CHECKS=lint` runs lint plus the i18n check, `RUN_CHECKS=n` or
  `SKIP_CHECK=1` skips — the latter bypasses the whole hook including the direct-to-`main` guard.)
- The hook is not installed in every checkout — check that `core.hooksPath` is set; a successful
  gated push from a tree without the hook proves nothing.

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
- After touching anything under `packages/web`, also run `npm run typecheck` — `vite build` does not
  type-check, so a type error there surfaces nowhere else until CI.
- **Before trusting any verification output** — especially a command that returned clean — read
  [`verification-pitfalls.md`](.agents/docs/verification-pitfalls.md). An empty output is not a
  passing check; several plausible commands here check nothing at all.
- Touching CI install or caching (`bun.lock`, turbo `inputs`, `tools/ci/install-deps.sh`, the
  `refresh-cache` label)? Read [`node-modules-cache.md`](.agents/docs/node-modules-cache.md) first.

## Review Agents

Two read-only reviewer subagents live in `.agents/agents/`. Their charters are the source of truth —
read the file, don't paraphrase it from here.

- **Delegate with the charter, never an improvised brief.** Hand the subagent its
  `.agents/agents/<name>.md` charter file as binding instructions. Never re-type or paraphrase a
  charter from memory, and never invent a new agent or edit a charter without asking the user.
  See `.agents/rules/agent-delegation.md`.
- **Run the review pass first.** Before spawning a `code-quality` reviewer, run `npm run review`
  and attach its artifact to the brief alongside the feature description — see
  `.agents/rules/agent-delegation.md` for the `--emit-prompts` fallback when no backend exists.

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
- **Never copy upstream EE source — clean-room reimplement instead.** Upstream `packages/ee/` (and `packages/server/api/src/app/ee`) is under the proprietary Activepieces Enterprise License, not MIT; this repo is MIT-only. When restoring a feature that lived under upstream `ee/` (API keys, SSO, RBAC, audit logs, git sync), NEVER copy the EE source verbatim (no `git show <upstream-sha>:packages/ee/...`, no pasting bodies/structure) — that infringes the Enterprise License. Reimplement from behavior only (HTTP contract, schema-as-idea, auth flow); copyright protects the specific source, not the functionality or API. Code already in the MIT core is safe to reuse. See `.agents/rules/edition-safety.md`.

## Useful Links

- [Database Migrations Playbook](.agents/skills/db-migration/SKILL.md)
- [Verification Pitfalls](.agents/docs/verification-pitfalls.md)
- [CI node_modules Cache](.agents/docs/node-modules-cache.md)

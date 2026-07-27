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
- **The trailers must sit in one final block with no blank line between them.** Git treats only the
  *last paragraph* as the trailer block, and the `DCO Sign-off` job reads sign-offs with
  `git show -s --format='%(trailers:key=Signed-off-by,valueonly)'` (`.github/workflows/ci.yml`).
  So a message ending in `Signed-off-by:`, blank line, `Co-Authored-By:` has **no** parsed sign-off
  and fails the required check, even though the line is plainly visible in `git log`. Correct shape:

  ```
  Closes #123

  Signed-off-by: Name <email>
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

  Verify before pushing, don't eyeball the message — and check the whole branch, not just `HEAD`,
  because the job checks every non-merge commit in the PR:
  `git log --no-merges --format='%h %an <%ae> | %(trailers:key=Signed-off-by,valueonly)' origin/main..HEAD`.
  Keep `--no-merges` — the job passes it too, so an unsigned merge commit from a branch update is
  not a failure and must not be treated as one.
  Every line must show the sign-off matching that commit's own author; a blank right-hand side is
  the failure.

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
- After touching anything under `packages/web`, also run `npm run typecheck` — `vite build` does not
  type-check, so a type error there surfaces nowhere else until CI.

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
- **An enumerated `--filter` list is itself the defect — it silently omits whatever it does not
  name.** `lint-core` named six packages and `lint-qadams` globbed `@aiqadam/qadam-*`; between them
  they missed `@aiqadam/cli`, `tests-e2e`, and — because the glob is `qadam-*` while the packages are
  `qadam` **s** `-framework` / `-common` — two packages that read as covered and were not (#184).
  Note the trap in verifying this: `turbo run lint --filter='@aiqadam/qadam-*' --dry=json` *does*
  list `@aiqadam/qadams-framework` under `.tasks[].package`, because a dependency appears in the
  graph for its `build` task. Filter on `.task == "lint"` before concluding anything. CI now runs
  `turbo run lint` and `turbo run typecheck` unfiltered, so coverage cannot drift again; keep it that
  way rather than reintroducing a package list. Note the residual limit, so nobody over-reads it: a
  package that never declares the script is still silently uncovered — that is the #148 class, which
  an unfiltered run does not solve.
- **Renaming an npm script needs a sweep that is not extension-scoped.** `.husky/pre-push` invokes
  root scripts and has no file extension, so a `grep --include='*.yml' --include='*.json'
  --include='*.md' --include='*.sh'` sweep for `lint-core` missed it entirely and the rename would
  have broken every `CLAUDE_PUSH=yes git push` with a "Lint failed" message that named the wrong
  cause (caught in review on #184). Grep the whole tree with only `node_modules`/`dist` excluded.
  Also note the hook is **not installed in the sandbox container** (no `core.hooksPath`, no
  `.git/hooks/pre-push`), so a successful `CLAUDE_PUSH=yes` push there is not evidence that the
  gate passes — it is evidence that the gate did not run.
- **Turbo `inputs` narrower than the files the script actually covers makes a check silently
  cache-skip.** `lint`'s `inputs` listed `src/**` but not `test/**`, while the `api` lint script
  covers `'src/**/*.ts' 'test/**/*.ts'` — so with remote caching on, a PR touching only
  `packages/server/api/test/**` got a cache hit and linted nothing, repo-wide (fixed in #148).
  A green check here means "the inputs turbo hashed did not change", not "the script ran".
  Audit with `turbo run <task> --filter=<pkg> --dry=json` and compare the resolved input list
  against the glob the script itself uses.
- **A relative `inputs` path that does not exist is dropped silently, with no warning.** `lint`
  carried `"../../.eslintrc.json"`, which only reaches the repo root from a depth-2 package; from
  `packages/server/*` it resolved to the non-existent `packages/.eslintrc.json` and from the qadams
  to `packages/qadams/.eslintrc.json`, so no shared ESLint config was hashed at all and editing a
  rule served a cached pass (#164). Address repo-root files with `$TURBO_ROOT$/…`, and confirm the
  entry actually appears in the `--dry=json` `inputs` map — an entry in `turbo.json` is not
  evidence that turbo resolved it.
- **A skipped required check never reports a conclusion.** Under the repo ruleset
  (`strict_required_status_checks_policy: true`), a required context that is skipped via
  `paths-ignore` or a job-level `if:` leaves the PR permanently unmergeable. A required job must
  always run and always resolve, even when it short-circuits.
- **Empty check conclusions read as pending, not passing.** `gh pr view --json statusCheckRollup`
  returns `""` (not `null`) for an in-flight check. Treat any falsy conclusion as pending, or you
  will read a running pipeline as green.
- **Reading the repo from a working tree that has drifted behind `origin/main` produces confident,
  wrong measurements with no symptom.** A long session merges PRs while `/workspace` stays on the
  commit it started at; every `grep`, `cat` and `node -e "require('./package.json')"` then reports
  the old tree. This is how the root `test-unit` filter list was quoted into an issue after the
  filter had already been widened. `git fetch && git merge --ff-only origin/main` before measuring
  anything you intend to publish, or read the file via `git show origin/main:<path>` so the source
  is unambiguous.
- **A filename is not a manifest.** `packages/web/src/assets/fonts/inter-v20-latin-500.ttf` and
  `-600.ttf` are named as Latin subsets and are full 2,849-codepoint `Inter 18pt` builds including
  Cyrillic and Greek; the `.woff2` files beside them, identically named, really are Latin subsets.
  An issue was filed asserting "every Inter subset shipped is Latin-only" purely from the names.
  When a claim is about a file's *contents* — glyph coverage, exported symbols, which routes a
  bundle registers — open the file. The cheap corroboration here was size: 343 KB versus 24 KB at a
  comparable weight is not a format difference.
- **A tool that cannot do its job may still emit a plausible artifact instead of failing.** Rendering
  the Open Graph card with `@resvg/resvg-js` in this container produced a valid 13 KB PNG containing
  the logo and **no text at all** — there are no system fonts installed, so every text node was
  dropped silently. Exit code 0, sane file size, correct dimensions. For anything whose output is
  visual or binary, inspect the artifact itself (`Read` the image, parse the bytes); a size and an
  exit code are not evidence. Relatedly, when a pipeline is `generate → consume`, confirm the
  generate step ran: a missing `python3` failed one step while the next happily consumed the stale
  input from the previous run.
- **Pushing to the branch of an already-merged PR exits 0 and changes nothing.** The ref updates, the
  push reports success, and no warning appears anywhere — but the PR is closed, so the commit never
  reaches `main`. A review finding on #168 was fixed this way three minutes after that PR merged, and
  then reported in its own comment thread as landed; `main` never received it. Before pushing a review
  fixup, check `gh pr view <n> --json state`, and afterwards confirm the commit is reachable from
  `main` with `git branch -r --contains <sha>` rather than concluding from a successful push. "The
  command reported success" is not "the outcome happened" — which is the whole subject of this list.
- **A wait loop over the check rollup reports success from an incomplete set.** `gh pr checks <n>
  --json bucket --jq 'all(.bucket!="pending")'` is vacuously **true** in the first seconds after a
  push, when only the fast contexts (`PR Title`, `Classify changed paths`) have registered — `all`
  over a set that does not yet contain the required checks says "everything resolved". A watcher
  built on it exited immediately and reported a PR green while `Lint + Unit Tests` had not started.
  Name the required contexts and require each to be present **and** non-pending:
  `[.[]|select(.name=="Lint + Unit Tests" or …)|select(.bucket!="pending")]|length` against the
  expected count. Then run the expression once before trusting it and confirm it returns the
  *not-ready* answer — a gate only ever checked against the state it should accept is not checked.
- **A loop whose tool is missing hangs silently instead of failing.** The replacement for the above
  piped into `jq`, which is not installed here (see the table below): every iteration printed
  `jq: command not found` into a log nobody was reading, the condition never became true, and it ran
  until killed by hand. `gh` has `--jq` built in and needs no external binary. Same family as the
  missing `python3` above: run a command once and look at its output before looping on it.
- **A test that fails after your own edit is not evidence for the first mechanism you think of.**
  Deleting a `vi.mock` factory left one `mockReset()` reference behind, so four tests failed with
  `ReferenceError`. That was read as "the mock is load-bearing" and written into a commit message as
  fact — the mock was inert, because the module under test never imported the path it mocked. Read
  the actual error before writing the conclusion, and state a mechanism only after confirming it by
  removing the thing and watching the behaviour change.
- **"It passes" does not tell you why, and the why decides what the test covers.** A case in
  `test/unit/app/workers/machine/machine-list-filter.test.ts` was credited as tenant-isolation
  coverage. It is not: `machineService.list` ignores its `platformId` argument and drops every
  `DEDICATED` worker, so the test cannot fail if platform scoping regresses — there is none to
  regress (#202). Before crediting a test with covering something, break that thing on purpose and
  confirm the test goes red.

### What the sandbox container does not have

Verified with `command -v`, not from memory. Three separate stalls in one session came from assuming
one of these was present.

| tool | state | consequence |
| --- | --- | --- |
| `bun` | **missing** | `turbo` cannot execute any task — `npm run lint-all`, `typecheck`, `test-unit` all die with `Unable to find package manager binary`, because `packageManager` is `bun@1.3.3`. `turbo … --dry=json` still works, so audits are fine and runs are not. |
| `jq` | **missing** | pipelines into it fail per iteration; use `gh --jq`, which needs no binary. |
| `python3` / `python` | **missing** | see the `generate → consume` entry above. |
| `turbo`, `tsc` on PATH | missing | use `npx`. |
| `psql`, `redis-cli` | missing | integration tests need the docker-compose services, not a bare shell. |
| `node` | v22 | CI pins **24** (`_verify.yml`); a version-sensitive local result is not authoritative. |
| git hooks | **not installed** | `core.hooksPath` empty, no `.git/hooks/pre-push`, no `.husky/_`. A successful `CLAUDE_PUSH=yes git push` here is evidence the gate **did not run**. |
| `docker`, `gh`, `node`, `npx` | present | usable. |

So the authoritative local signals are `npx vitest`, `npx eslint`, `npx tsc` and
`turbo … --dry=json`; anything routed through `turbo run` or a git hook proves nothing here, and
saying so is better than substituting a command that returns clean.

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

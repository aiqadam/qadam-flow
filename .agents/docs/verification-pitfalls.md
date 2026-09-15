# Verification pitfalls — commands that look like verification but verify nothing

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
  `turbo run lint`, `turbo run typecheck` and `turbo run test` unfiltered, so coverage cannot drift
  again; keep it that way rather than reintroducing a package list. The `test` one was this same bug
  a second time: the root `test-unit` script named four packages plus `api`, so
  `packages/server/worker` (18 files, 215 tests) and all 14 core qadams that declare `test`
  (40 files, 231 tests) ran in no CI job at all — and the worker suite had been red for months
  before anyone looked (#215). Note the residual limit, so nobody over-reads it: a
  package that never declares the script is still silently uncovered — that is the #148 class, which
  an unfiltered run does not solve. That limit was live for `typecheck` until #245: seven of the eight
  TypeScript packages declared no such script, so the unfiltered job checked `web` and nothing else,
  and `packages/server/engine` — whose `build` is esbuild, which strips types without checking them —
  had never been type-checked at all. Closing it cost 250 errors, two of them live bugs (#246, #248).
  All eight now declare one; do not remove a `typecheck` script to make a red build green.
  **The class is not gone, only this instance of it.** Still uncovered today, each for a stated
  reason: the ~230 qadam packages are checked by their `build` but their tsconfigs exclude `test/**`,
  so the ~14 core qadams shipping tests have none checked; `shared` and `engine` check `src` only
  (13 and 21 errors respectively if their spec projects are turned on); and `packages/server/worker`'s
  `lint` glob is still `src/**`, so its tests are type-checked but not linted (~97 pre-existing
  findings). Before trusting any `turbo run <task>`, confirm the packages you care about actually
  declare the script — `--dry=json`, filtered on `.task`, with `<NONEXISTENT>` counted as uncovered.
- **Renaming an npm script needs a sweep that is not extension-scoped.** `.husky/pre-push` invokes
  root scripts and has no file extension, so a `grep --include='*.yml' --include='*.json'
  --include='*.md' --include='*.sh'` sweep for `lint-core` missed it entirely and the rename would
  have broken every `RUN_CHECKS=yes git push` with a "Lint failed" message that named the wrong
  cause (caught in review on #184). Grep the whole tree with only `node_modules`/`dist` excluded.
  Also note the hook is **not installed in every checkout** (no `core.hooksPath`, no
  `.git/hooks/pre-push`), so a successful `RUN_CHECKS=yes` push there is not evidence that the
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
  wrong measurements with no symptom.** A long session merges PRs while the working tree stays on
  the commit it started at; every `grep`, `cat` and `node -e "require('./package.json')"` then
  reports the old tree. This is how the root `test-unit` filter list was quoted into an issue after the
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
- **A swallowed failure is worse than a failing command, and it hides in build files, not just CI.**
  `Dockerfile` carried `RUN bun install || true` from the fork import. When `redis-memory-server`'s
  postinstall began failing, the `|| true` discarded it, the build continued with no `node_modules`,
  and it died twenty lines later at `npx turbo run build` with `exit code: 127`. Every symptom pointed
  at turbo; the cause was the install. It survived many reviews because this list was read as being
  about *test and CI* commands. It is not. Grep anything you are about to trust for `|| true`,
  `|| exit 0`, `set +e`, `continue-on-error`, and `2>/dev/null` on a step whose success the next step
  depends on — in `Dockerfile`, `docker-entrypoint.sh`, `run.sh` and npm scripts, not only under
  `.github/`. If a step's failure would change what the next step does, it must not be allowed to pass.
  Two caveats learned the hard way. **Count the occurrences before claiming a sweep** — this
  `Dockerfile` has three `bun install` invocations and only one was covered, so the fix was partial
  while its own commit message implied otherwise. And **`docker-entrypoint.sh` runs `set -uo pipefail`
  without `-e` on purpose**, with an in-file comment explaining that the `AP_WORKER_TOKEN` mint depends
  on it; that one is a documented exception, not a bug to "fix".
- **Establish provenance with `git blame` before attributing a defect to anyone.** The `|| true` above
  reads exactly like something a coding agent would add to force a green build, and it was assumed to
  be that. `git blame` puts it in the `Init` fork-import commit — inherited from upstream, not written
  by any session here. Blaming the wrong author in a commit message, an issue or a report is itself a
  defect, and it is cheap to avoid.
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
  piped into `jq`, which was not installed in that environment: every iteration printed
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

# CI/CD Module

## Summary
Qadam Flow ships as a **monolithic Docker image** — the entire web frontend, API server, worker,
engine, all 211 community qadams and 27 core qadams are bundled into one OCI image
(`ghcr.io/aiqadam/qadam-flow`). The engine and the qadam builds it runs come from the same commit,
and CI/CD is built around that artifact.

It is no longer the only artifact. The same pipeline publishes **241 packages to npm** under the
`@aiqadam` scope: `@aiqadam/shared`, `@aiqadam/qadams-framework` and `@aiqadam/qadams-common`
(step 1a of #433, #475) and the 238 qadams (step 1b, #476). Every one versions independently of
the root `package.json`, so a `vX.Y.Z` tag on the image says nothing about any of their versions,
and every one of those numbers is a public contract. What each number means and how it may move is
[`.agents/rules/versioning.md`](../rules/versioning.md) (ADR-0001, ADR-0002) — this file describes
the pipeline, not the rule. Under ADR-0001 the pipeline changes again: changesets raise the versions
(#796), required CI gates check them (#797), and `shared` stops being published (#799).

The qadams ride the **same** pack half, the **same** `publish-order.txt` manifest and the
**same** `tools/ci/publish-packed-tarballs.sh` as the three framework packages, behind
`--include-qadams` on the pack step. That is a constraint, not a convenience: the publishing
job is deliberately duplicated (below), and a separate qadam pipeline would mean a third copy
of it, which the suite below is explicit that nothing would pin. The manifest keeps the three
framework packages ahead of the 238 so a registry client racing the tail never resolves a
qadam before what it depends on; the 238 depend on those three and on none of each other, so
nothing else in the tail needs ordering. Packing them is bounded-concurrency (the registry
round trip in `packagePrePublishChecks` is per package); publishing them stays serial.
`ci.yml`'s `pack-smoke` deliberately covers only the three — building the catalogue on every
PR would duplicate the Docker build — and the qadam-specific half is covered by
`tools/ci/test-publish-workspace-invariants.sh` instead.

Publishing them is **decoupled from the release tag** (#496): a `v*` tag publishes whatever is
current as a side effect of releasing the engine, and `publish-packages.yml` publishes without
a release. Both call the same reusable workflow for **packing**, so the expensive half cannot
drift. The **publishing** half is duplicated in each of them on purpose (#498): environment
secrets do not resolve inside a reusable workflow — measured, and reported against
actions/runner since 2021 — so a shared publishing job reads `NPM_TOKEN` as an empty string.

`NPM_TOKEN` therefore belongs on the `npm-publish` GitHub Environment and **nowhere else**.
Do not move it to repository scope to "fix" an empty-token failure: every workflow in the repo
can read a repository secret, including the ones that install and build the third-party
dependency graph on a pull request, and the environment's required reviewers would then gate
the timing of the publish rather than the credential. `tools/ci/test-publish-packed-tarballs.sh`
pins the two copies of the publishing job equal, and pins on each copy the properties #486
bought: the `npm-publish` environment, the shared publisher script as the job's last step, a
credential-less checkout, `id-token: write`, and an allowlist of the three actions the job may
use. The step count is pinned too, so adding a step to this job is a deliberate edit rather
than a drive-by, and so is adding a third copy of the job to a third workflow. It also greps
the job for install and package-runner invocations — that one is a denylist, so read it as
"no install we know how to spell", and read the regex in the file before relying on it.

## Key Files
- `Dockerfile` — single source of truth for the production image (multi-stage: `base → build → run`)
- `.github/workflows/ci.yml` — PR + push validation, conditional image push on `main`
- `.github/workflows/release.yml` — tagged release builds (`v*`): Docker image, `:latest`, GitHub Release
- `.github/workflows/publish-packages.yml` — manual (`workflow_dispatch`) npm publish, no release (#496)
- `.github/workflows/_verify.yml` — reusable lint + typecheck + unit-test gate, called by the three above
- `.github/workflows/_pack-framework-packages.yml` — reusable build-and-pack for the three
  `@aiqadam` framework packages, called by `release.yml` and `publish-packages.yml`. The
  publishing job is deliberately NOT shared: environment secrets do not resolve inside a
  reusable workflow, so each caller carries its own (#498)
- `.github/workflows/pr-title.yml` — semantic PR-title enforcement
- `.github/workflows/cleanup.yml` — scheduled cleanup of old workflow runs

## Triggers and Behaviour

| Trigger              | Workflow           | Lint+Unit | Docker build | Image push     | Tags                                    |
|----------------------|--------------------|-----------|--------------|----------------|-----------------------------------------|
| `pull_request`       | `ci.yml`           | ✅        | ✅           | ❌             | —                                       |
| `push: main`         | `ci.yml`           | ✅        | ✅           | ✅             | `:<next>-main.<n>`, `:main`, `:sha-<7chars>` |
| `push: tag v*`       | `release.yml`      | ✅        | ✅           | ✅             | `:X.Y.Z`, `:X.Y`, `:latest` — and the npm publish |
| `workflow_dispatch`  | `publish-packages.yml` | ✅    | ❌           | ❌             | npm only; no image, no GitHub Release   |
| `pull_request` title | `pr-title.yml`     | —         | —            | —              | Validates Conventional Commits format   |
| `schedule daily`     | `cleanup.yml`      | —         | —            | —              | Deletes runs older than 30 days         |

Every PR and every push to `main` runs the **full** Docker build, not just the `build` stage.
This guarantees the run-stage (final image assembly) is exercised before merge, eliminating
the class of bugs where `COPY --from=build` paths break only at runtime.

## Key Decisions

### 1. Single Dockerfile for CI and production
**Decision**: CI uses `./Dockerfile` directly — same as self-host deploys and the release image.
**Reason**: Eliminates drift. If CI passes, the production image is provably buildable from the
same commit. The Linux-kernel analogy is intentional: `make` produces the bzImage; CI runs `make`.

### 2. Full build on every trigger (Variant D)
**Decision**: PRs run `docker build` end-to-end without `--target build` shortcut.
**Reason**: Run-stage bugs (missing `COPY --from`, wrong `WORKDIR`, broken `ENTRYPOINT`) must
fail at PR-review time, not after merge. The ~5-minute CI cost is acceptable; revisit if PR
volume exceeds free-tier budget.

### 3. Image push gated on `main` and tags only
**Decision**: PR builds locally, never pushes to GHCR.
**Reason**: PR runs are throwaway. Pushing every PR would flood GHCR with one-shot tags,
add traffic costs (on private repos), and provide no operational value.

### 4. Cache strategy: GHA `type=gha`, asymmetric by event (#811, measured)
**Decision**: Every leg reads `cache-from: type=gha,scope=<matrix.cacheScope>`. Only a push to
`main` writes `cache-to`, and it writes `mode=min`, not `mode=max`. A PR build (and a manual
`workflow_dispatch`) writes no `cache-to` at all.
**Reason**: Measured on 20 legs across 10 runs: `cache-to,mode=max` cost ~150 s of a ~6.4 min
median leg, and the cache it wrote from `refs/pull/N/merge` is unreadable by any other PR — only
a re-push to the SAME PR benefits, and that re-push already gets the turbo remote cache's full
hit rate. `mode=max` also exports the intermediate `build`-stage layers; `run` is `FROM base`, not
`FROM build`, so only a commit that touches neither the root manifests nor `packages/` can reuse
that stage's cached `bun install` layer on its next build — the common case gets no benefit from
exporting it, so even `main`'s own write does not need `mode=max`. What the layer cache actually buys
(10-13 of ~49 steps coming back `CACHED`) never includes the expensive steps — `bun install`,
`turbo run build` — because `COPY` invalidates them on every commit; the turbo remote cache is
what makes a warm build fast (246/246 tasks cached), not this layer cache.

### 5. Image tagging convention (ADR-0001 "The platform version", #798)
- `:<next>-main.<n>` — the exact version a `main` image reports, e.g. `:2.0.0-main.1234`. `<next>` is
  the root `package.json` (the last release) raised by the pending `@aiqadam/platform` changesets
  (at least a patch); `<n>` is `github.run_number`. Computed by `tools/ci/compute-main-version.mjs`
  in `ci.yml`'s `platform-version` job and written into the image's root `package.json` by the
  Dockerfile (`tools/scripts/stamp-platform-version.mjs`), so `apVersionUtil.getCurrentRelease()`
  reports it. Semver orders it below the release it leads to.
- `:main` — moving pointer to latest green main
- `:sha-<7chars>` — immutable per-commit tag (used by future deploy automation)
- `:X.Y.Z` — immutable release tag (the `vX.Y.Z` git tag without its `v`)
- `:X.Y`, `:latest` — moving pointers to the latest release (not moved by a prerelease tag)

The qadam half of ADR-0004 (#851) is computed in the same job and not yet applied: `tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs` plans a `<next>-main.<n>` snapshot version for each qadam with its own pending changeset (same `<n>`), logs a warning when the changesets plan or the release archive is unavailable and builds more snapshots instead, and `platform-version` writes the plan's summary to the run. The image keeps released numbers until `follow` and an image's store seed can serve a snapshot to the flows pinned to its release — #807 built the flavours and the seeding tool but deliberately does not wire the seed into the image yet (the issue's own gate: "seed only after #851 lands"), since the store never overwrites an already-stored version and a `:main` build's changed-but-unbumped qadam code would otherwise be masked by whichever `:main` image seeded first. The image's labels already carry the `<n>` -> commit record: `org.opencontainers.image.version` (`<next>-main.<n>`) and `org.opencontainers.image.revision`, and two explicit labels name the counter and commit for ADR-0004.

Flavours (`:fat` / `:slim`, ADR-0003, #807) add a `-<flavour>` suffix to each of these:
`:<next>-main.<n>-<flavour>`, `:main-<flavour>`, `:sha-<short>-<flavour>`. `image_publish` adds the
unsuffixed `:main` and `:sha-<short>` aliases on fat for consumers that predate flavours. Release tags
are `:<version>-<flavour>`, with `:fat` / `:slim` moving only on a stable release, `:latest` moving
only for fat, and bare `:<version>` / `:<major.minor>` kept on fat for compatibility. No `:edge`, no
`:nightly`, no `:canary`. Self-hosters pin to `:<version>-slim` or `:<version>-fat`; CI/CD internals
and the canary (#116) use `:main` / `:sha-...`.

### 6. Single-arch only (linux/amd64)
**Decision**: No `linux/arm64` builds in CI yet.
**Reason**: Doubles build time. Re-evaluate after we have a baseline of arm64 self-host demand.
Apple Silicon users can build locally via `docker build --platform=linux/arm64 .`.

### 7. PR title enforcement
**Decision**: Keep `amannn/action-semantic-pull-request` from upstream — require
`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `ci:`, `build:`, `revert:`.
**Reason**: PR titles feed the changelog. Conventional Commits keeps the changelog parseable
and lets the changelog skill stay simple.

### 8. Authentication via built-in `GITHUB_TOKEN`
**Decision**: No external secrets needed. GHCR push uses the workflow's built-in token with
`permissions: { packages: write }`.
**Reason**: Simpler ops, no token rotation, no leakage risk via misconfigured secrets.

### 9. CE integration suite: sharded 3 ways (#811, measured)
**Decision**: `integration-run` is a 3-way `matrix: shard: [1, 2, 3]`, each leg its own `services:`
Postgres + Valkey, running `vitest --shard=<i>/<N>` via `QF_VITEST_SHARD`
(`packages/server/api/package.json`'s `test-ce-command`). `check-migrations` runs in shard 1 only.
**Reason**: vitest's own breakdown put `import` (a fresh process per file under
`pool: 'forks'`/`--no-file-parallelism`) at roughly half of the 542 s median step. Sharding by
file cuts both `import` and `tests` per shard; running `check-migrations` in every shard would
just repeat an identical schema-drift check against N identical fresh databases. vitest shards by
file count, not duration, so the 3 shards are not perfectly balanced — a duration-aware rebalance
is a follow-up once this has run for real. The required context stays "CE Integration Tests": the
`integration` gate job reads `needs.integration-run.result`, which already aggregates a matrix
(`failure` if any leg failed).

### 10. node_modules cache: saved from `push: main` only (#811, measured)
**Decision**: `_verify.yml`'s "Save built node_modules" step now also requires
`github.event_name == 'push' && github.ref == 'refs/heads/main'`. Every job restores from the
same key as before; only the write is restricted.
**Reason**: The Actions cache sat at 9.97 of 10 GB, and `node-modules-*` entries were 72% of it —
23 entries at ~314 MiB each, 15 minted from PR refs, none surviving a day. Every Renovate PR
changes `bun.lock`, so every one minted a fresh key that only that PR's own re-pushes could ever
read, while crowding out the turbo and Docker entries everyone shares. A PR with an unchanged
lockfile already computes `main`'s key and hits it. Measured over 324 samples, a hit now saves
only ~14 s (`install-deps.sh`'s own install step is ~29 s cold); see
[`node-modules-cache.md`](../docs/node-modules-cache.md).

### 11. `image` no longer waits on `verify`; `image_publish` still does (#811, measured + reviewed)
**Decision**: `image`'s `needs:` dropped `verify` (kept `changes`, `platform-version`), so the
Docker build now runs in parallel with `verify`'s lint/unit-test gate instead of after it.
`image_publish` — the job that actually pushes the public `:main`/`:sha-<short>`/`:<version>`
manifest — added `verify` to its own `needs:` to compensate.
**Reason**: `verify`'s 5.5 min median was pure serialization in front of the PR's fully-green
time for no correctness check the build itself doesn't also make (`verify` type-checks, it does
not bundle; the build step proves the Dockerfile path including the vite bundle and the engine's
esbuild). `image` has no external side effect — a PR build never pushes — so unblocking it is
free. `image_publish` does have one: it is the one place a broken `main` commit could still reach
a public tag if `verify` had failed, since no required check re-verifies the commit before this
push-time step. Gating publish rather than build keeps the parallelism win and keeps that one
guarantee. One consequence: `image_publish` can now report `skipped` on a push to `main` for a
reason other than "not a push event" (namely `verify` failed) — `e2e` and `e2e-execution-modes`
tolerate an `image_publish` skip but now only when `github.event_name != 'push'`, so a push-time
skip no longer falls back to silently testing an unrelated previous `:main` build.

## What This Replaces

Forked from upstream Activepieces, which carried a large set of workflow files designed for
their own infra: GHCR org (`ghcr.io/activepieces/*`), BetterStack, Checkly, Crowdin, Depot,
EE license server, separate npm publishes per qadam, staging/canary/prod deploy targets.

All of them were dropped. Per-qadam npm publishing came back later in this fork's own form — one
pack-and-publish pipeline for the `@aiqadam` scope (#475, #476, see Summary) — not as upstream's
per-piece workflows. The replacement is the 4 files in `.github/workflows/` above,
focused only on what this fork needs: build → test → publish a single image.

## What Is NOT Yet Covered (Backlog)

- **API integration tests** (`npm run test-api`) — requires Postgres + Redis services in CI.
  Adds ~30 min runtime. Will be added as a parallel job once we measure cache stability.
- **E2E tests (Playwright)** — same blocker; postpone until after the API integration job
  is in place.
- **Multi-arch builds** (`linux/arm64`) — see Decision 6.
- **Image security scanning** (Trivy/Grype) — separate scheduled workflow, post-MVP.
- **Auto-deploy** — no workflow in this repo deploys anything. A QA instance that auto-deploys
  `:main` (redeployed several times a day) lives outside the repository (ADR-0004, citing #784);
  how it pulls the image is not defined here, and no deployment target is defined in this repo.
- **Dependabot security fixes** — check the repo's Dependabot alerts for the current count
  (`gh api /repos/aiqadam/qadam-flow/dependabot/alerts`). Separate cleanup task.

## Cost Profile (Public Repo)

GitHub Actions and GHCR are free for public repos: unlimited storage, unlimited bandwidth,
unlimited minutes. Cost calculus matters only if/when the repo becomes private.

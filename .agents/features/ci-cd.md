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

### 4. Cache strategy: GHA `type=gha`
**Decision**: `cache-from: type=gha,scope=monolith` + `cache-to: type=gha,mode=max,scope=monolith`.
**Reason**: Built into GitHub Actions, free, no external infra. Warm-cache build is ~7–10 min
vs ~25 min cold. Single shared scope works because the Dockerfile layers are layer-stable
between branches (only the application source layer churns).

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

Flavours (`:fat` / `:slim`, ADR-0003, #807) will add a `-<flavour>` suffix to each of these. No
`:edge`, no `:nightly`, no `:canary`. Self-hosters pin to `:X.Y.Z` or `:latest`; CI/CD internals and
the canary (#116) use `:main` / `:sha-...`.

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
  how it pulls the image is not defined here, and no staging target exists in this fork.
- **Dependabot security fixes** — check the repo's Dependabot alerts for the current count
  (`gh api /repos/aiqadam/qadam-flow/dependabot/alerts`). Separate cleanup task.

## Cost Profile (Public Repo)

GitHub Actions and GHCR are free for public repos: unlimited storage, unlimited bandwidth,
unlimited minutes. Cost calculus matters only if/when the repo becomes private.

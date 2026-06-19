# CI/CD Module

## Summary
Qadam Flow ships as a **monolithic Docker image** — the entire web frontend, API server, worker,
engine, all 211 community qadams and 27 core qadams are bundled into one OCI image
(`ghcr.io/aiqadam/qadam-flow`). The philosophy is Linux-kernel-style: everything is built-in,
no separate npm publishes per qadam, no per-piece versioning. CI/CD is built around this
single artifact.

## Key Files
- `Dockerfile` — single source of truth for the production image (multi-stage: `base → build → run`)
- `.github/workflows/ci.yml` — PR + push validation, conditional image push on `main`
- `.github/workflows/release.yml` — tagged release builds (`v*`)
- `.github/workflows/pr-title.yml` — semantic PR-title enforcement
- `.github/workflows/cleanup.yml` — scheduled cleanup of old workflow runs

## Triggers and Behaviour

| Trigger              | Workflow           | Lint+Unit | Docker build | Image push     | Tags                                    |
|----------------------|--------------------|-----------|--------------|----------------|-----------------------------------------|
| `pull_request`       | `ci.yml`           | ✅        | ✅           | ❌             | —                                       |
| `push: main`         | `ci.yml`           | ✅        | ✅           | ✅             | `:main`, `:sha-<7chars>`                |
| `push: tag v*`       | `release.yml`      | ✅        | ✅           | ✅             | `:vX.Y.Z`, `:latest`                    |
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

### 5. Image tagging convention
- `:main` — moving pointer to latest green main
- `:sha-<7chars>` — immutable per-commit tag (used by future deploy automation)
- `:vX.Y.Z` — immutable release tag
- `:latest` — moving pointer to latest release tag

No `:edge`, no `:nightly`, no `:canary`. Self-hosters pin to `:vX.Y.Z` or `:latest`; CI/CD
internals use `:main` / `:sha-...`.

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

Forked from upstream Activepieces, which had **28 workflow files** designed for their own
infra: GHCR org (`ghcr.io/activepieces/*`), BetterStack, Checkly, Crowdin, Depot,
EE license server, separate npm publishes per qadam, staging/canary/prod deploy targets.

All 28 files were dropped. The replacement is 4 files focused only on what this fork needs:
build → test → publish a single image.

## What Is NOT Yet Covered (Backlog)

- **API integration tests** (`npm run test-api`) — requires Postgres + Redis services in CI.
  Adds ~30 min runtime. Will be added as a parallel job once we measure cache stability.
- **E2E tests (Playwright)** — same blocker; postpone until after the API integration job
  is in place.
- **Multi-arch builds** (`linux/arm64`) — see Decision 6.
- **Image security scanning** (Trivy/Grype) — separate scheduled workflow, post-MVP.
- **Auto-deploy** — no staging target exists yet for this fork.
- **Dependabot security fixes** — 184 alerts (21 critical) on the repo. Separate cleanup task.

## Cost Profile (Public Repo)

GitHub Actions and GHCR are free for public repos: unlimited storage, unlimited bandwidth,
unlimited minutes. Cost calculus matters only if/when the repo becomes private.

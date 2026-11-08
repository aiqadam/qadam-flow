# Dependency updates (Renovate)

`renovate.json` at the repo root configures **Renovate** as the dependency-update bot.
Nothing else in CI reads it, and adding it does not change the `node_modules` cache key
(that key hashes `bun.lock`, `bunfig.toml`, `package.json`, `.npmrc` and
`tools/ci/install-deps.sh` — see [`node-modules-cache.md`](./node-modules-cache.md)).

## Why Renovate and not Dependabot

The deciding constraint is the text `bun.lock` (Bun ≥ 1.2) in a bun-workspaces monorepo.

- **Renovate updates it.** The `bun` manager's default file matching is
  `/(^|/)bun\.lockb?$/`, which matches both `bun.lock` and `bun.lockb`, and its
  `lockFileMaintenance` lists `bun.lock` explicitly. Renovate does not write the lock
  itself — it shells out to `bun`, so a Bun ≥ 1.2 workspace is handled by bun.
  <https://docs.renovatebot.com/modules/manager/bun/>. The March 2025 report that text
  lockfiles were not updated (<https://github.com/renovatebot/renovate/discussions/34625>)
  was closed by its author in April 2025 as fixed.
- **Dependabot is weaker here, and fails a requirement.** The GitHub docs table marks the
  `bun` ecosystem as **version updates supported, security updates _not_ supported**, and
  the GA announcement says the same ("Support for `bun` security updates will be added in
  the future"). This ticket's first policy line is "security PRs open immediately", which
  Dependabot cannot do for bun.
  <https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories>
- **The bun security-update gap is the deciding factor.** Dependabot does not support bun
  security updates, which the ticket's first policy line requires. On top of that, users
  still report a bun-workspace lockfile problem — Dependabot updating `package.json` but not
  the workspace-root `bun.lock` (<https://github.com/dependabot/dependabot-core/issues/11602>;
  the issue was closed as completed in April 2025, but reports continue through 2026-02).
  Every CI job here runs `bun install --frozen-lockfile` (`tools/ci/install-deps.sh`), so such
  a PR fails CI rather than shipping.
- Renovate's `packageRules` express the whole policy below natively (grouping by pattern,
  per-rule schedule, labels, automerge); Dependabot groups cannot carry per-group schedules
  and have no native automerge.

## Policy encoded in `renovate.json`

| Requirement | Where |
| --- | --- |
| Security PRs open immediately | `vulnerabilityAlerts` + `osvVulnerabilityAlerts` (vulnerability PRs ignore `schedule`) |
| Patch automerge once CI is green | `matchUpdateTypes: ["patch","pin","digest"]` → `automerge`, `platformAutomerge` (green = the required contexts, including `Image + Sandbox Gate`, see below) |
| `isolated-vm` never automerges, and its Dockerfile pins move with the manifests | last `packageRules` entry (`automerge: false`, `platformAutomerge: false`, `groupName: "isolated-vm"`) + the `customManagers` regex entry (#810, #832) |
| Minor batched weekly | `matchUpdateTypes: ["minor"]` → `groupName: "minor-updates"`, Monday schedule |
| Major individually, labelled `tech-debt` | `matchUpdateTypes: ["major"]` → `addLabels: ["tech-debt"]`, no group |
| `@types/node` stays on the runtime major | `matchPackageNames: ["@types/node"]` → `allowedVersions: "<25"` (see below) |
| Group the coupled families | one `packageRules` entry per family (below) |
| `@ai-sdk/*` + `ai` + `ai-gateway-provider` + `@openrouter/ai-sdk-provider` | `groupName: "ai-sdk"`, and it includes `@aiqadam/qadam-ai` (see "The one exception" below) |
| `@opentelemetry/*` | `groupName: "opentelemetry"` |
| `@aws-sdk/*` | `groupName: "aws-sdk"` |
| `@tiptap/*` | `groupName: "tiptap"` |
| `@fastify/*` + `fastify` | `groupName: "fastify"` |
| `@typescript-eslint/*` | `groupName: "typescript-eslint"` |
| `@radix-ui/*` | `groupName: "radix-ui"` |

The family rules carry `matchUpdateTypes: ["minor","patch"]` so a family is grouped for
minor/patch but a major still opens on its own. The `minor-updates` rule is listed before
the family rules; Renovate merges `packageRules` in order, so a family's `groupName`
overrides the catch-all name while the Monday `schedule` remains — that is what keeps a
family from being split across PRs.

`@types/node` is capped at the Node runtime major — `.nvmrc`, the `Dockerfile` base image and
every workflow's `node-version` (24 today). Types ahead of the runtime let the typecheck pass
calls that throw in production, and newer majors also raise the TypeScript floor (#906:
`@types/node@26` needs TS 5.6). Move the cap in the PR that moves the runtime, not on its own.
Inside the cap, every release from 24.13.3 on also declares `typeScriptVersion` 5.6, which the
TypeScript 5.9 bump (#627) satisfies. `@aiqadam/shared` and `qadam-assemblyai` still declare
24.11.0: they are versioned packages, and a `devDependencies` change there forces a changeset
(CI gate 1), so they catch up at their next release or with the Renovate PR that touches them.

The `isolated-vm` entry must stay **last** in `packageRules`. Renovate applies every matching rule
in order and the later one wins, so a rule appended after it that sets `automerge: true` (or
that matches `isolated-vm` through a broader pattern) would silently re-enable unattended merges
of the sandbox boundary. Add new rules above it.

## Automerge and the Docker image / sandbox jobs (#832)

`platformAutomerge` hands the merge to GitHub, which waits for the **required** status contexts
only. `Docker Image` and `Sandbox e2e (privileged)` are not required and cannot be: both are
skipped on some diffs (`image` on a docs-only diff, `sandbox-e2e` on a pull request that touches no
sandbox path), and a skipped required context reports no conclusion, which wedges the PR. #771 reached `main` that way with both red (#810).

`ci.yml` therefore has an always-reporting gate job, `image-sandbox-gate`, whose **job name is the
required context: `Image + Sandbox Gate`** (same pattern as `verify` -> `Lint + Unit Tests` and
`integration` -> `CE Integration Tests`). It waits for `image` (both architectures) and
`sandbox-e2e`, and fails when either failed or was cancelled. A skip passes only when it is
justified: `image` skipped on a docs-only diff, `sandbox-e2e` skipped on a pull request whose
`sandbox_relevant` classifier output is not `true`. Any other skip fails, because an unexplained
skip is how #831 silently stopped every image build on `main`. Consequences worth knowing:

- A pull request whose `Lint + Unit Tests` is red also shows this gate red, because `image` is
  skipped behind `verify`. It is already unmergeable; the second red context is expected.
- The gate finishes only once the image build and (when relevant) the sandbox e2e have finished,
  so a Renovate patch PR now waits for the Docker build before it can automerge.
- It does not cover `Publish multi-arch manifest`, `E2E Suite` or `E2E execution mode`: those run
  against the published `:main` on PRs and only gate what happens after a merge. A red `image`
  already skips them on `main`.

**It is required.** `Image + Sandbox Gate` was added to the required status checks of the
`main protect` ruleset on 2026-11-08 (#832), so a PR, a Renovate automerge included, cannot merge
while `Docker Image` or `Sandbox e2e (privileged)` is red. The ruleset matches the job name, so
renaming the job leaves every PR waiting on a context that never reports: change the ruleset in
the same breath.

## The 238 qadams are excluded

`packages/qadams/**` is disabled entirely, and `@aiqadam/*` packages are disabled as
dependencies. A bump inside a qadam requires that qadam's own version bump and a
republish ([`versioning.md`](../rules/versioning.md)), so the bot must never make that
change silently. This also covers `packages/qadams/{framework,common}`. The qadams still
appear transitively in the root `bun.lock`; the exclusion only stops PRs that target their
own `package.json` files.

### The one exception: `@aiqadam/qadam-ai` in the `ai-sdk` group (#1027)

`@aiqadam/qadam-ai` compiles against the same AI SDK as the platform. Two different patches of
`@ai-sdk/provider` / `@ai-sdk/provider-utils` are not assignable to each other, so when the
`ai-sdk` group moved `packages/server/*` and `packages/web` and left the qadam on its old pins,
`bun.lock` carried two copies and `@aiqadam/qadam-ai#build` failed with `TS2322`. That happened on
#815, #871, #896 and #911 (each fixed by hand on the Renovate branch), then on #972 (#997, #999)
and #1025 (#1024), which reached `main` through automerge and turned the `Docker Image` jobs red.

So a `packageRules` entry re-enables `ai`, `@ai-sdk/*`, `ai-gateway-provider` and
`@openrouter/ai-sdk-provider` (the packages the qadam pins exactly like the platform does) for
`packages/qadams/community/ai/package.json` only. The `ai-sdk` group then moves the platform and
the qadam in one PR, and `renovate-changeset.yml` writes the `@aiqadam/qadam-ai` changeset. The
rule stays narrow: no other qadam, and no other dependency of this qadam, is enabled.

- **Majors are included.** The family rule groups minor and patch only, so a major (e.g. `ai`
  8.x) opens per package, like every major, and now edits the qadam too. Leaving majors out would
  bring the two-copy split back on every major. The workflow still writes a `patch` changeset and
  gate 2 cannot see a dependency major, so the reviewer sets the qadam's level by hand (a new
  `ai` major usually changes what a step does).

- It sits below the qadam disable (it re-enables) and below the patch-automerge rule (it sets
  `automerge: false`), because a later matching rule wins, and above the `isolated-vm` rule,
  which stays last.
- Renovate automerges a group only when every upgrade in it is automerge
  (`config.automerge = config.upgrades.every(...)` in `lib/workers/repository/updates/generate.ts`),
  so an `ai-sdk` PR that moves the qadam waits for a human. That is deliberate: the policy above
  exists so a published qadam's dependency never changes unattended, and the reviewer answers the
  versioning behaviour question for the changeset the workflow wrote (`patch` by default; raise it
  if an existing step would notice the change). A batch that moves only packages the qadam does
  not pin (`@ai-sdk/provider`, `@ai-sdk/google-vertex`, `@ai-sdk/replicate` in the server packages)
  still automerges; that case is what the required build below is for.

The backstop is a required build, not this rule. `Lint + Unit Tests` builds every qadam that
depends on any of those packages (`tools/ci/ai-sdk-qadams.mjs`, tested by
`tools/ci/test-ai-sdk-qadams.sh`; step "Build the qadams that depend on the AI SDK" in `_verify.yml`), so a split copy fails a required check on the
PR that introduces it, however that PR was opened. Before it, qadams had no `typecheck` script and
`turbo run test` built only dependencies, so the break showed up only in the image build.

## DCO: `:gitSignOff`

Every commit in this repo must carry a `Signed-off-by` trailer matching its author, and the
`DCO Sign-off` job is a required check with no bot exemption
(`.github/workflows/ci.yml`). Renovate's `:gitSignOff` preset adds
`Signed-off-by: {{gitAuthor}}`, templated from the identity Renovate actually commits with,
so it cannot drift from the author the way a hard-coded string would. Because the hosted app
sets its own git author, do **not** set `gitAuthor` — `:gitSignOff` follows whatever the
platform resolves.

## Advisory OSV scan

The ticket's OSV/audit gate now ships as an **advisory, non-blocking** CI job — `osv-scan`
in `.github/workflows/ci.yml`. It scans the text `bun.lock` directly with
`google/osv-scanner-action/osv-scanner-action` (pinned to `v2.6.0`); osv-scanner lists
`bun.lock` under Javascript in
<https://google.github.io/osv-scanner/supported-languages-and-lockfiles/>, so no manifest
conversion is needed.

- **Advisory by construction.** The job sets `continue-on-error: true` and is deliberately
  not one of the contexts the `main protect` ruleset requires (`Lint + Unit Tests`,
  `CE Integration Tests`, `DCO Sign-off`, `Validate Conventional Commits format` and
  `Image + Sandbox Gate`, #832). A scanner finding — or
  the OSV.dev API being unreachable — is a backlog signal, not a merge blocker. Promoting it
  to blocking is a separate decision: it would need the job made unconditional and fronted by
  an always-reporting gate job, the way `verify` and `integration` are built, because a
  skipped required context reports no conclusion under the repo's ruleset.
- **It takes no part in the install path.** The scan is a pure lockfile read: no
  `bun install`, no dependency cache restore/save, and no change to the `node_modules` cache
  key documented in [`node-modules-cache.md`](./node-modules-cache.md). It cannot churn or
  consume that cache.
- The scanner action is pinned to an exact release rather than a moving major tag: unlike the
  first-party actions the rest of CI uses, `google/osv-scanner-action` publishes no `v2` alias.

## Deferred (not in this change)

- **Enabling Dependabot / repository security alerts.** Renovate's `vulnerabilityAlerts`
  reads them when present; `osvVulnerabilityAlerts` downloads the OSV database and queries
  it offline meanwhile.
  Turning alerts on is a repository setting, not a file, so it is a merger action.

## Merger actions (cannot be done from a PR)

1. Install the Mend Renovate app (<https://github.com/apps/renovate>) on
   `aiqadam/qadam-flow`; the config does nothing until the app runs.
2. Enable "Allow auto-merge" in repository settings, so `platformAutomerge` can act.
3. ~~Add `Image + Sandbox Gate` to the `main protect` required status checks~~ — done on
   2026-11-08 (#832; see above).
4. Confirm the `DCO Sign-off` job passes on the first Renovate PR. If the app ignores
   `:gitSignOff` (it should not), the fallback is to exempt the bot in the DCO job, which
   is a workflow change and should be a deliberate, separate decision.

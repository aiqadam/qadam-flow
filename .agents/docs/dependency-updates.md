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
| Patch automerge once CI is green | `matchUpdateTypes: ["patch","pin","digest"]` → `automerge`, `platformAutomerge` |
| Minor batched weekly | `matchUpdateTypes: ["minor"]` → `groupName: "minor-updates"`, Monday schedule |
| Major individually, labelled `tech-debt` | `matchUpdateTypes: ["major"]` → `addLabels: ["tech-debt"]`, no group |
| Group the coupled families | one `packageRules` entry per family (below) |
| `@ai-sdk/*` + `ai` | `groupName: "ai-sdk"` |
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

## The 238 qadams are excluded

`packages/qadams/**` is disabled entirely, and `@aiqadam/*` packages are disabled as
dependencies. A bump inside a qadam requires that qadam's own version bump and a
republish (AGENTS.md, "Published-package version bumps"), so the bot must never make that
change silently. This also covers `packages/qadams/{framework,common}`. The qadams still
appear transitively in the root `bun.lock`; the exclusion only stops PRs that target their
own `package.json` files.

## DCO: `:gitSignOff`

Every commit in this repo must carry a `Signed-off-by` trailer matching its author, and the
`DCO Sign-off` job is a required check with no bot exemption
(`.github/workflows/ci.yml`). Renovate's `:gitSignOff` preset adds
`Signed-off-by: {{gitAuthor}}`, templated from the identity Renovate actually commits with,
so it cannot drift from the author the way a hard-coded string would. Because the hosted app
sets its own git author, do **not** set `gitAuthor` — `:gitSignOff` follows whatever the
platform resolves.

## Deferred (not in this change)

- **OSV/audit CI gate** (ticket item). `osv-scanner` *does* read `bun.lock` — it is listed
  under Javascript in <https://google.github.io/osv-scanner/supported-languages-and-lockfiles/> —
  so the gate is feasible. It is deferred because a new blocking job needs a scanner binary
  installed and network access in CI, and this config-only change should not bundle a gate
  whose failure modes cannot be exercised here. A follow-up can add it advisory first.
- **Enabling Dependabot / repository security alerts.** Renovate's `vulnerabilityAlerts`
  reads them when present; `osvVulnerabilityAlerts` downloads the OSV database and queries
  it offline meanwhile.
  Turning alerts on is a repository setting, not a file, so it is a merger action.

## Merger actions (cannot be done from a PR)

1. Install the Mend Renovate app (<https://github.com/apps/renovate>) on
   `aiqadam/qadam-flow`; the config does nothing until the app runs.
2. Enable "Allow auto-merge" in repository settings, so `platformAutomerge` can act.
3. Confirm the `DCO Sign-off` job passes on the first Renovate PR. If the app ignores
   `:gitSignOff` (it should not), the fallback is to exempt the bot in the DCO job, which
   is a workflow change and should be a deliberate, separate decision.

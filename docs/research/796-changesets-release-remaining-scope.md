# #796 — "Versioning: introduce changesets — release PR, Renovate changesets, retire release-drafter (ADR-0001)": the implementation is complete; the one open item is a maintainer secret, not code

**Status:** no code change required in this ticket's own scope.
**Investigated:** 2026-11-12, on `agent/796-versioning-introduce-changesets-release`
(branch at `main`'s current head, `19b59634`).

## What the issue asked

Five scope items (issue body checklist):

1. Introduce changesets, verified against the bun workspaces (`workspace:*`) and the
   ~240 qadam packages.
2. Release PR flow: version bumps, internal-dependency bumps, changelogs, tags —
   absorbing #494 deliverable 3 (the `shared → framework → common` cascade).
3. Renovate: a dependency-changing PR on a qadam gets a generated changeset, replacing
   `.github/workflows/qadam-version-bump.yml`.
4. Retire `release-drafter` (`.github/release-drafter.yml`) and `qadam-version-bump.yml`.
5. Root `package.json` holds the last released version, raised by the release PR
   together with the tag (tracked jointly with #798).

The issue's own comment 1 (@binalirustamov) already records items 1–4 and most of 5 as
delivered by #821 and #828, leaving three checklist lines open: add the `CHANGESETS_TOKEN`
repo secret, open and merge the first release PR, and (optional) remove the now-unused
`QADAM_BUMP_TOKEN` secret.

## Finding: items 1–4 are on `main`; the only open item is the same maintainer secret #798 already found blocking

This session re-verified each claim directly against the current tree rather than taking
the comment's word for it:

- **Item 1 — changesets on bun workspaces.** `.changeset/config.json` exists, with
  `baseBranch: main`, `updateInternalDependencies: patch`, and an `ignore` list for the
  non-versioned packages (`api`, `web`, `tests-e2e`, `@aiqadam/cli`, `@aiqadam/engine`,
  `@aiqadam/server-utils`, `worker`). 77 pending `.changeset/*.md` files sit on `main`
  today, written by real PRs across `packages/qadams/**` and `packages/shared` since
  #821 merged — the mechanism is in active use, not just configured.
- **Item 2 — release PR flow.** `.github/workflows/changesets.yml` ("Open or update the
  release PR") runs `changesets/action` on every push to `main`; `updateInternalDependencies:
  patch` in the config is what delivers the `shared → framework → common` cascade from
  #494 deliverable 3 — no extra cascade code was ever needed, it's a changesets built-in.
- **Item 3 — Renovate changesets.** `.github/workflows/renovate-changeset.yml` writes a
  `patch` changeset for any versioned package whose `package.json` dependency section
  moved on a `renovate/*` branch with no changeset yet, gated on the same
  `CHANGESETS_TOKEN` (a PAT, not `GITHUB_TOKEN`, so the commit re-triggers required checks).
- **Item 4 — retirement.** `.github/release-drafter.yml` and
  `.github/workflows/qadam-version-bump.yml` are both absent from `.github/workflows/`
  today; only `changesets.yml` and `renovate-changeset.yml` remain. `QADAM_BUMP_TOKEN`
  has zero references anywhere in the repo (`grep -rn QADAM_BUMP_TOKEN` across `*.yml`
  and `*.md` returns nothing) — the code-side half of removing it is already done, the
  secret value itself is a repo-settings action no worker token can reach (`gh secret
  list` returns `403 Resource not accessible by personal access token` from this
  session's credentials).
- **Item 5 — root version.** `package.json` at the repo root reads `"version": "1.1.0"`,
  the last released version, per #828's fix after that PR had briefly pushed it to
  `2.0.0` without a tag.
- **Remaining checklist item — open/merge the first release PR.** Still blocked, and
  still not something this session (or #798's session on 2026-11-08) could close:
  `changesets.yml` has failed on **every** push to `main` since before #798's
  investigation, most recently today on `19b59634` (run `43301770876`,
  2026-11-12T20:35:14Z), with the same sequence as #798 documented four days earlier —
  `Require the release-PR token` prints `::error::CHANGESETS_TOKEN is not set...`, then
  the `changesets/action` step itself fails with `##[error]Bad credentials -
  https://docs.github.com/rest`. The secret #796's own remaining-scope list asks a
  maintainer to add (fine-grained PAT, Contents + Pull requests read/write) is still
  absent four days and nine more pushes to `main` later.

## Why no code change was made here

Every item this ticket's scope lists as code — the changesets config, the release-PR
workflow, the Renovate changeset generator, and the retirement of `release-drafter` and
`qadam-version-bump.yml` — is already on `main`, verified against the actual files
rather than the issue comment's summary. The three remaining checklist lines are a repo
secret only an org maintainer can add, the maintainer then merging the resulting
`chore(release): version packages` PR unedited, and an optional unused-secret deletion
that needs the same repo-admin access this session's token does not have (confirmed by
the `403` on `gh secret list`). Writing a hand-built substitute release PR would
duplicate — and could conflict with — the automated one the moment the secret is added,
which is the opposite of "merge it without hand-editing any versions" that #796 itself
asks for.

## Recommendation

- Leave #796 open; its only remaining items are the maintainer actions #798's research
  already flagged, confirmed still blocking four days and nine `main` pushes later.
- A maintainer adds `CHANGESETS_TOKEN` (fine-grained PAT, Contents + Pull requests
  read/write) as a repo secret. Once added, the next push to `main` lets `changesets.yml`
  open the release PR on its own; merging that PR unedited produces `v2.0.0` and closes
  both #796 and #798's shared blocker.
- Once the secret is confirmed working, a maintainer can also delete the now-unused
  `QADAM_BUMP_TOKEN` repo secret (no code or workflow references it any more).

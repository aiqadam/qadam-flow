---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#776"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0001. Everything versioned in the repo follows semver, declared with changesets and enforced in CI

## Decision

Every version number in the repository is a semver promise to a named consumer, declared per
package in the PR that makes the change, and checked by CI.

**What each number means.**

| Layer | Contract with | major | minor | patch |
| --- | --- | --- | --- | --- |
| Platform (root `package.json`, release tag, images) | instance operators | the upgrade needs operator action — always with an entry in `docs/install/configuration/breaking-changes.mdx` | new capability | fix |
| SDK — `@aiqadam/qadams-framework`, `@aiqadam/qadams-common` | qadam authors | a broken public API, or a new engine ↔ qadam `context` version | new export | fix |
| Qadam | flows that pin it | an action, trigger or prop removed or renamed; a new required prop without a default; a narrowed type; a changed output shape; **or a behaviour change an existing step would notice** | new action or trigger, optional prop, new output field | fix that changes none of the above |
| `@aiqadam/shared` | nobody outside the repository | — | — | — |

**`shared` becomes private.** It is no longer published; `qadams-framework` bundles what it uses from
`shared`, including types, at publish time. Versions already on npm stay installable for the `0.x`
qadams that pin them and are marked with `npm deprecate`.

**The SDK.** Qadams import only `@aiqadam/qadams-framework` and `@aiqadam/qadams-common`. The 104
symbols they import from `shared` today (measured as described in
`adr/assets/2026-10-08-versioning-prototype/README.md`) move into `qadams-framework`, which re-exports them, and a
lint rule forbids qadams from importing `shared`. `qadams-framework@1.0.0` and
`qadams-common@1.0.0` are cut once that move, the `shared` bundling and the API-diff gate are in
place; before 1.0.0 the SDK makes no compatibility promise.

**Qadams move to `1.0.0` one by one**, each at its next change. Until then the `0.x` rule applies
(minor = breaking). **The compatibility promise is the caret range:** a version inside `^` of a pin
(`^1.2.3` → `<2.0.0`, `^0.3.1` → `<0.4.0`) is a drop-in replacement at the contract level, and
anything that moves a pin automatically may move it only inside that range.

**The platform version.** Root `package.json` holds the **last released** version. A release PR
raises it together with the tag (`version-tag-gate` keeps them equal). Images built from `main` report
a prerelease computed at build time (`2.1.0-main.<n>`), which semver orders below the release, so a
canary never claims a release it is not. The first release under this scheme is `2.0.0`. Image tags
carry the exact version (`:<version>`, with a `-<flavour>` suffix where images come in flavours)
plus moving tags; builds from `main` are tagged `:main` (`:main-<flavour>` where images come in
flavours).

**Who raises versions: changesets.** A PR that changes a versioned package adds a `.changeset/*.md`
naming each package, its level and one line on what changed. The release PR collects them, raises
versions (including dependents inside the repo), writes changelogs and tags. Conventional Commits
stay for history; their format check stays.

**CI gates, all required.**
1. A change under `src/` of a versioned package has a changeset for that package.
2. The declared level is not below the level CI computes: the public `.d.ts` diff for the SDK; the
   actions / triggers / props / output schema diff for qadams.
3. A version is never published twice — checked against the registry's version list, not
   `origin/main` (#783).
4. A platform major has a `breaking-changes.mdx` entry (`breaking-change-gate`, tied to the changeset).
5. Tag equals root `package.json` (`version-tag-gate`).
6. Qadams do not import `@aiqadam/shared`.
7. Compatibility floors are consistent: every qadam's `minimumSupportedRelease` is at or below the
   current platform version, and `maximumSupportedRelease`, when set, is not below it.

A behaviour change with an unchanged schema cannot be detected; it is a question in the PR template
and an obligation in the agent rule, not a gate. A maintainer-only `semver-override` label bypasses
gate 2 when CI over-estimates the level; every use stays visible on the PR. Gate 2 can only demand
a higher level, never accept a lower one. ADRs that build on this one add their gates to the same
required set.

**Conventions.** One always-on rule, `.agents/rules/versioning.md` (ADRs that build on this one add
their rules to it), listed in the AGENTS.md rules index; one skill, `versioning`, with the
procedure (choosing a level, writing a changeset, what to do when gate 2 disagrees, when the
override applies); the "Published-package version bumps" section of AGENTS.md replaced by a pointer;
a section in `CONTRIBUTING.md`; `docs/build-qadams/qadam-reference/qadam-versioning.mdx` rewritten for external
authors. Everything else that restates the rules links to the rule instead.

## Context

The answers behind this ADR are recorded in `adr/assets/2026-10-08-versioning-session.md`.


Inventory from #776 and #783 (`main` @ `717e7390` / `94dc9ae3`):

- **Platform.** Latest tags `v1.0.0` / `v1.1.0` (2026-07-21); root `package.json` is `2.0.0` (raised by
  #326, never tagged). `apVersionUtil.getCurrentRelease()` reads `package.json`, so every image built
  from `main` reports `2.0.0`, and `isSupportedRelease` filters the qadam catalogue against it.
- **Packages.** `shared` 0.156.0, `framework` 0.35.0, `common` 0.17.0 in the tree — three independent
  counters — and 238 qadams on `0.0.x`–`0.18.x` (`assemblyai` alone past `1.0.0`; #776's title says
  `0.13.x`, but `slack` and `google-sheets` are `0.18.0`). `shared` was raised 29 times
  since 2026-09-21 (#783) and has 13 versions on npm.
- **Nothing enforces a bump.** `packagePrePublishChecks` diffs against `origin/main`, which is empty
  on the publish path, so it never fires there; `check-qadam-version-bumps` sees only dependency
  sections. 46 qadams in image `v1.1.0` differ from npm under the same version
  (`schedule@0.1.17`'s `ru.json`, #448). AGENTS.md describes protection that does not exist.
- **Compatibility floors disagree**: `0.36.1` (qadam-builder skill), `0.58.0` (`properties.mdx`),
  `0.82.0` (`versioning.ts`), and a changelog entry resetting every qadam's `minimumSupportedRelease`
  to `0.0.0`. `maximumSupportedRelease` is effectively never set.
- **Behaviour changes broke users with identical schemas**: `telegram-bot` `secret_token` (#397),
  long polling (#393).
- **Existing gates to build on**: Conventional Commits format check, `version-tag-gate` and
  `breaking-change-gate` in `.github/workflows/release.yml`, `check-qadam-version-bumps`,
  `release-drafter`, `qadam-version-bump.yml` for Renovate branches.
- An exact pin only protects a flow if the number means something; today the same number can name
  different code in the image and on npm.

## Options considered

### Option A — semver per layer, changesets, required gates (chosen)

Each package's level is declared where the change is reviewed, CI checks the declaration against
what it can measure, and the release is mechanical. It closes every finding in #783 and gives #776's
five questions an answer each (see Consequences).

### Option B — versions derived from Conventional Commits (release-please / semantic-release)

Rejected. One commit gets one level, but a PR routinely touches several qadams that need different
levels; with ~240 packages and squash merges that cannot be expressed. A behaviour-driven major would
hide in a commit type instead of being a reviewed line.

### Option C — manual bumps in `package.json` plus the #783 gates

Rejected. Gates can force *a* bump but not record *why* or at what level per package, and the
release still needs hand-written changelogs and tags.

### Option D — keep `0.x` everywhere and document "minor means breaking"

Rejected. It makes every minor a break, so the caret-based fallback can never cross one — which is
exactly why #424's fallback could not move `tables@0.3.1` to a props-compatible `0.4.5`.

### Sub-decisions

| Question | Chosen | Rejected, and why |
| --- | --- | --- |
| Separate ADR, and numbered first | Yes — the support window and the store model both build on what a version means | Folding it into either: semver for the whole repo can be accepted or rejected on its own; #776 is its own ticket |
| Qadam contract | Schema **and** observable behaviour | Schema only: #397 and #393 would have been patches |
| Qadams `0.x` → `1.0` | Each at its next change | All at once: 238 releases with no code change; staying on `0.x`: see Option D |
| Platform `package.json` | Last released version; prereleases for `main` builds | Next release (today's state): `main` images claim an unreleased version; tag-only with a placeholder: local builds report `0.0.0` |
| Gates | 1–7 required from the first changesets release; override label for gate 2 | Advisory first: unenforced checks are how #783 happened; only the changeset-presence gate required: levels would go unchecked |
| Where qadam-facing `shared` symbols go | Re-exported from `qadams-framework` | A new `@aiqadam/qadams-sdk`: a second package to keep stable and version in step, for symbols that are mostly enums and helpers (`QadamCategory` in 196 qadams, `isNil` in 36, `MarkdownVariant` in 16) |
| `qadams-framework@1.0.0` | Once `shared` is out of its API, bundled, and the API-diff gate exists | Now: the first `shared` move would force 2.0 at once; at the first external author: too late for a contract |
| Conventions | Rule + skill + docs, one source | AGENTS.md section only: bloats the root doc; skill only: unread when its trigger is missed |
| `shared` | Private; bundled into `framework` | Published without promises: every `shared` change ripples through authors' lockfiles (#494, #772); a stable public API: spends majors on the most-changed internal package |

## Consequences

**Answers to #776.** (1) Platform version: as above. (2) Platform and packages: independent semver
per package; a platform release ships whatever SDK versions its tree holds; how long it keeps
running an older SDK major is a separate decision. (3) The engine ↔ qadam contract has its own axis — the framework
major — so `minimumSupportedRelease` / `maximumSupportedRelease` only express platform-release
floors, kept consistent by gate 7. (4) Offline: no compatibility signal in this ADR needs GitHub or
npm at run time; the "update available" check keeps degrading as today. (5) One source of truth: the
rule, with everything else linking to it.

**New obligations.** A changeset in every PR that changes a versioned package; the behaviour question
answered honestly; SDK `.d.ts` bundling so `framework` can ship without `shared`.

**Migration work.** Introduce changesets (and verify it reads the bun workspaces); replace
`release-drafter` and `qadam-version-bump.yml` (Renovate PRs get a generated changeset); rewrite
`packagePrePublishChecks` against the registry; stop publishing `shared` and deprecate its versions;
tag `2.0.0`; image tag scheme; prerelease versions for `main` builds; the gates and their fixture
tests; the rule, skill and docs; audit and fix the disagreeing floors and constants.

**Harder.** More majors than today, honestly declared. One more file per package-changing PR. Gates
land together with the first changesets release PR, not before, so gate 1 never demands a tool that
does not exist yet. Until a release PR raises them, images built from `main` carry changed package
code under the last released number — today each PR raises the version itself; how `main` builds
version unreleased code is a separate decision (#784).

## Evidence

- #776 inventory and #783 measurements, cited in Context with their commits.
- `tables@0.5.1` on npm depends on `shared@0.155.0`, `common@0.17.0`, `framework@0.35.0` exactly
  (`npm view`, 2026-10-08).
- Upstream Activepieces stopped publishing `shared`, `pieces-framework` and `pieces-common` when it
  moved to self-contained bundles (activepieces#13834).

## Follow-ups

- Changesets: setup, bun workspace check, release PR, Renovate integration; retire `release-drafter`
  and `qadam-version-bump.yml`.
- Gates 1–7 with fixtures; `semver-override` label restricted to maintainers.
- Platform: tag `2.0.0`; prerelease versions for `main` builds; image tag scheme.
- SDK: move the qadam-facing `shared` symbols into `qadams-framework`; lint ban; API-diff gate; cut
  `qadams-framework@1.0.0` / `qadams-common@1.0.0`.
- `shared`: stop publishing, bundle into `framework` (code and `.d.ts`), `npm deprecate` old versions.
- Conventions: `.agents/rules/versioning.md` + index row, `versioning` skill + registry row,
  AGENTS.md pointer, CONTRIBUTING section, `qadam-versioning.mdx` rewrite, clean-up of the
  qadam-builder skill and floor constants.
- Decide how `main` builds version unreleased package code (#784).
- Close #776 and #783 against this ADR once accepted; fold #494 deliverable 3 (cascade) into
  changesets' internal-dependency bumps.

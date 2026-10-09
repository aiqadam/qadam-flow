---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#784"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0004. Builds from `main` give changed packages their own prerelease versions; qadam snapshots stay in the instance store and are never published

Builds on: ADR-0001 (the version in the repository is the last released one, changesets, the gate
set, the platform's `-main.<n>` prerelease, the caret-range promise), ADR-0002 (framework majors and
the census) and ADR-0003 (the versioned store, release artifacts archived and never rebuilt, the
catalogue, the unavailable-version fallback, GC).

## Decision

A version number names exactly one artifact, in images built from `main` as in releases. In a
build from `main`:

- **A package with a pending changeset** is built and versioned `<next>-main.<n>`. `<next>` is the
  version the release PR would give it if it were cut from that commit (changesets' release plan).
  `<n>` is the counter of the platform's own prerelease in the same build (#798). With a pending
  minor changeset, `tables` in build 412 is `tables@1.3.0-main.412`, in the image whose platform
  reports `2.1.0-main.412`. The number is computed at build time and never committed: the
  repository keeps the last released version (ADR-0001).
- **A package without a pending changeset** enters the image as its released artifact, taken from
  the release archive (ADR-0003, #804) and not rebuilt, so a released number always names released
  bytes. Qadams still on `0.x` (the legacy npm format, ADR-0003) are built from the tree until their
  `1.0.0`, and gate 9 below checks them.
- **A qadam gets a snapshot only for its own changeset.** A change to `qadams-framework` or
  `qadams-common` does not give the qadams that depend on them snapshot versions, because the
  framework chain is the platform's (ADR-0003). This rule covers `main` builds only. It does not
  change ADR-0001's release PR, which still raises dependents inside the repository. A qadam that
  the release plan raises only as a dependent keeps its released number and artifact in `main`
  builds, and gets its new version at the release.

**When the plan or the archive is unavailable.** A `main` build that cannot read changesets' release
plan, or cannot reach the release archive, does not fail. It builds **every** package from the tree
as a snapshot and logs a warning. `<next>` is then the next patch of each package's last release,
the rule `compute-main-version.mjs` already applies to a platform with no pending changeset. Every
number still names one artifact, and the extra snapshots are collected like any other (see
Consequences). A release build never takes this path; it fails instead. The platform's own version
stays fail-closed (see Consequences).

**Pin format.** A pin (after its optional `^` or `~`), an alias and the engine accept a release
`x.y.z` or a snapshot `x.y.z-main.<n>`, and no other prerelease. One parser in `shared` decides this
for the step-settings and request schemas, the alias, the store's coordinates and the engine, and
replaces the patterns each of them carries today (see Context). The alias becomes `name@version`, split at the last `@`.
Today it is `name-version`, split at the last hyphen, which a `-main.<n>` tail also contains. Flows do
not store aliases: a step stores `qadamName` and `qadamVersion` apart. Aliases name directories in
the worker's install workspace, so existing `name-version` directories get a compatibility read path,
not a flow migration. The custom-qadam install schema keeps `x.y.z`: a `-main.<n>` number names an
official snapshot only.

**Storage.** A qadam snapshot is stored where the flows that pin it run. The image seeds it into the
instance's store like any other version, and the store's GC already keeps every pinned version,
drafts included (ADR-0003, #478). Qadam snapshots are **not published** to npm or to any other
registry, and they are not in the catalogue. The SDK exception is below. The archive of record for a
snapshot is the image that introduced it: `:sha-<commit>`, whose platform reports `-main.<n>` with
the same `<n>`. With each snapshot the store records the framework version it was built against.

**Snapshot pins stay on `-main` instances.** A `-main` instance is one whose platform version is a
`-main.<n>` prerelease. Flow export rewrites every snapshot pin to the release caret range of its
line: `1.3.0-main.412` becomes `^1.3.0`. Keeping snapshot pins is an explicit opt-in on export, so a
release instance receives one only when someone chose to send it. The rewrite stays inside the pin's
own caret range (`^1.3.0` is a subset of `^1.3.0-main.412`), the bound ADR-0001 sets for anything
that moves a pin automatically. On import the caret is stripped, as for any imported pin today, so
the step is pinned to the release `1.3.0` and ADR-0003's rules apply to it as to any release pin. The
rewrite changes the exported file only; the source instance's pins stay as they are.

**On the instance that holds the snapshot**, the instance setting `AP_QADAM_SNAPSHOT_POLICY`
decides:
- **`follow`**, the default on `-main` instances. When the instance starts on a new image, a step
  pinned to a snapshot moves to the version the image ships for that qadam if it is newer and inside
  the pin's caret range: a newer snapshot, or the release that graduated the line. The move passes
  ADR-0003's checks: props compatible, read from both versions' `metadata.json` in the store, and the
  target loaded. It is written to an audit record and can be reverted.
- **`pin`**, the default on release instances. Nothing rewrites the pin. The existing "update
  available" path offers the release once one is in range.

This replaces the 2026-10-08 draft, under which nothing on this instance rewrote a pin. `follow`
never moves a release pin: moving released code under a published flow is the automatic migration
ADR-0003 rejected (its Option C). It moves only snapshot pins, whose unreleased code ADR-0003 left to
this decision, and only inside the caret. Under both policies, steps pinned to a prerelease are
labelled "pre-release build" in the builder, MCP and runs.

**Where a snapshot is missing.** This covers an instance that imported a flow exported with
snapshots kept, and this instance after losing its volume. The pin is an unavailable version under
ADR-0003. Its caret range contains the release of the same line (`^1.3.0-main.412` contains `1.3.0`).
Prereleases count inside the caret, so on a `-main` instance the target can also be the image's newer
snapshot of a compatible line.

ADR-0003 moves an unavailable pin only when the catalogue shows the target's props are compatible.
A snapshot has no catalogue entry, so the props of the pinned snapshot come from its own
`metadata.json`:
- an export that keeps a snapshot pin embeds that file, taken from the instance store;
- the importing instance runs the check ADR-0003 runs against the catalogue, then the load check,
  and writes the audit record that allows a revert;
- the embedded file is untrusted input, trusted no further than the flow that carries it. It is
  parsed with the limits the store applies to `metadata.json`. The most a forged file can do is let
  the step move to a version inside its caret range, which the flow file could have pinned outright.

Where no metadata is available, after a volume loss or from an export without it, the step is not
moved. It is marked "version unavailable — update this step", as in ADR-0003. This replaces the
2026-10-08 draft, which extended ADR-0003's no-metadata path (load check only) to snapshot pins. This
ADR now adds no exception to ADR-0003's fallback.

**The SDK.** Only `qadams-framework` and `qadams-common` may go to npm as `-main.<n>`, under a
dist-tag other than `latest`. That is #494's prerelease channel. This ADR fixes its number; #494
sets its rate inside the npm cap.

This ADR adds **gate 9** to ADR-0001's required set. Every qadam in an image is either its released
artifact or carries a `-main.<n>` version. For bundles, "released artifact" means it matches the
integrity the catalogue records. For `0.x` qadams it means their own code and metadata match the npm
tarball. A release build contains released artifacts only. The gate is rolled out in steps:
1. a script measures today's `0.x` divergences;
2. the gate runs advisory while their changesets land in batches and their patch releases are
   spread under the npm cap;
3. it becomes required when the divergences reach zero, and before `2.0.0`, the first release under
   ADR-0001.

## Context

**The open half.** ADR-0001 keeps the last released version in the repository and lets the release
PR raise it. ADR-0001 itself notes ("Harder") that until then, images built from `main` carry
changed package code under the last released number. ADR-0003 answered #784 for released versions
and left this half open. The maintainer narrowed #784 to it on 2026-10-08. The options named there
are snapshot prereleases (1), "QA images are not release images" (2), and a "published ≡ tested"
check (4).

**What a pin is** (all at `af659857`). A step stores the exact version of the metadata the instance
offered: `qadamMetadata.qadamVersion` (`packages/web/src/features/qadams/utils/qadam-selector-utils.ts:242`,
`:271`; `packages/server/api/src/app/mcp/tools/ap-add-step.ts:141`). For official qadams that
metadata comes from the image's bundled manifest (`loadBundledQadams` → `loadFromDisk`,
`packages/server/api/src/app/qadams/metadata/utils/qadam-cache-utils.ts:44-102`). Under ADR-0003
the store keys code by `name@version` and checks its integrity. So the version a `main` image gives
a qadam is the version flows pin and the key the store files the code under.

**Where `main` images run.** On every push to `main` that is not docs-only, `ci.yml` pushes `:main`
and `:sha-<short>` (`.github/workflows/ci.yml:857-1046`). There were 228 first-parent commits on
`main` between 2026-09-08 and 2026-10-08. That is a mean of 7.4 a day; the median is 5 per calendar
day, or 6 on days with any commit, and the busiest day had 30. According to #784, QA
runs `:main` and is redeployed several times a day. The deployment lives outside this repository:
`.agents/features/ci-cd.md:146` still says no auto-deploy target exists. The canary in #116 will also
run `:main`.

**How often qadam code changes.** Over the same 31 days, 30 commits on `main` touched qadams'
`src/`, giving 365 (qadam, commit) pairs. Two commits make up 319 of them:
- #448 (`f6462939`, 2026-09-15), translations, touched 177 qadams;
- #542 (`bf7857ae`, 2026-09-24), raw HTTP bodies, touched 142 qadams.

The other 46 average about 1.5 a day.

**npm caps the scope** at about 26–38 publishes per rolling 24 h, and new versions of existing
packages count too (`tools/ci/publish-packed-tarballs.sh:63-74`, #583). Pacing does not help.

**Today's history shows identity without storage.** Before changesets, each PR raises its own
versions. Versions are mostly unique, but nothing kept them:
- `tables@0.4.6` (in images from 2026-09-24) and `tables@0.5.0` (2026-09-29 → 10-06) were never
  published, and npm has only `0.0.0-stage` and `0.5.1`;
- of the 238 qadam versions in image `v1.1.0`, 149 are not on npm.

ADR-0003's store fixes storage on each instance. ADR-0001's last-released numbers would break
identity instead: the number stays the same while the code changes.

**Prerelease pins are rejected everywhere a pin goes today** (at `af659857`):
- **Step settings.** `qadamVersion` in step settings is `VersionType`, `^([~^])?x.y.z$`
  (`packages/shared/src/lib/automation/flows/actions/action.ts:117`, `.../triggers/trigger.ts:16`,
  `packages/shared/src/lib/automation/qadams/dto/qadam-requests.ts:9,13`). Installs use
  `ExactVersionType`, `^x.y.z$` (`:7,11`).
- **Aliases.** An alias is `${name}-${version}` (`packages/shared/src/lib/automation/qadams/utils.ts:11-14`),
  and `trimVersionFromAlias` splits it on the last hyphen (`:33-35`).
- **The engine.** The engine's same-version match only accepts `x.y.z`
  (`packages/server/engine/src/lib/helper/qadam-loader.ts:19-23`), so a prerelease alias skips it.
  The later lookups fail as well:
  - `findInDistFolder` (`:292-296`) trims `@aiqadam/qadam-tables-1.3.0-main.412` to
    `@aiqadam/qadam-tables-1.3.0`, which matches no key in the dist index (keyed by package name,
    `packages/server/engine/src/lib/helper/qadam-dist-index.ts:127`);
  - the installed-copy lookup splits the alias the same way.

  The step fails with `QadamNotFoundError`.

Any option that puts a prerelease into a pin therefore widens the stored-flow contract.

**The same applies to #798.** The platform's `-main.<n>` will hit the same schemas. The builder
sends `CURRENT_VERSION` as `release` to `/registry`
(`packages/web/src/features/qadams/hooks/qadams-hooks.ts:352-358`), and the endpoint validates it as
`ExactVersionType` (`qadam-requests.ts:71-73`). Also, `isSupportedRelease` orders `2.1.0-main.5`
below a `2.1.0` floor (`qadam-cache-utils.ts:74-85`).

**Since then** (at `8ba81dfa`, 2026-10-10), three of those places have changed, each with its own
pattern:
- #828 (#798) accepts the platform's prerelease as `release` through a pattern that admits any
  semver prerelease (`PLATFORM_RELEASE_PATTERN`, `packages/shared/src/lib/automation/qadams/dto/qadam-requests.ts:10-14`,
  used at `:64` and `:79`). The image stamp writes only `X.Y.Z-main.<n>`
  (`tools/scripts/stamp-platform-version.mjs:24`). `isSupportedRelease` is unchanged
  (`packages/server/api/src/app/qadams/metadata/utils/qadam-cache-utils.ts:82-93`).
- #840 (#779) makes the engine read the store first, but only for an alias its own `x.y.z` pattern
  accepts (`packages/server/engine/src/lib/helper/qadam-loader.ts:26`, `:272-276`; `splitExactAlias`
  at `:298-302`).
- The store (#829) accepts any canonical semver as a version directory, prereleases included
  (`packages/server/utils/src/qadam-version-store/qadam-version-store-layout.ts:122-131`).

The step and install schemas still use `x.y.z` (`qadam-requests.ts:7-9`, `:16-18`). So what a
version may look like is decided in five places, and they disagree on prereleases. The worker names
each workspace member `qadams/<name>-<version>`
(`packages/server/worker/src/lib/cache/qadams/qadam-installer.ts:746`, `:818`), and the engine looks
installed copies up under that alias (`qadam-loader.ts:322`, `:332`). Flow export, in the UI, its
bulk variant and `ap_export_flow`, goes through one function, `flowService.getTemplate`
(`packages/server/api/src/app/flows/flow/flow.service.ts:585-616`; callers
`flow.controller.ts:187-195`, `packages/server/api/src/app/mcp/tools/ap-export-flow.ts:22`). Import
expands into add-step operations (`packages/shared/src/lib/automation/flows/operations/import-flow.ts:166-188`),
each of which strips a leading `^` or `~` from the pin
(`packages/shared/src/lib/automation/flows/operations/index.ts:388-391`, `:399-402`;
`packages/shared/src/lib/automation/flows/util/flow-qadam-util.ts:6-11`).

**Maintainer decisions (2026-10-10).** The 2026-10-08 draft listed its costs under Consequences.
@binalirustamov decided eight of them on 2026-10-10, and this text carries the answers:
1. irreversibility: snapshot pins stay on `-main` instances, and export rewrites them;
2. the pin format: only `-main.<n>`, through one parser, with `name@version` aliases;
3. QA not following `main`: `AP_QADAM_SNAPSHOT_POLICY`;
4. the fallback without a props check: metadata embedded in the export, and no move without it;
5. fragile `main` builds: the all-snapshots fallback build;
6. gate 9's clean-up: measure, then advisory, then required before `2.0.0`;
7. store growth: GC, a size metric and a warning;
8. framework changes: an accepted limitation, with the framework version recorded.

Each answer sits where its cost was described. They record the maintainer's choices on those points;
`deciders` is filled when the ADR as a whole is accepted.

## Options considered

### Option A — snapshot versions for changed packages, kept in the instance store; gate 9; prerelease label (chosen)

Option 1 of #784, without its "fetchable like releases" half, plus option 4 as a gate and the useful
part of option 2 as UX. It wins on four counts:
1. **One number names one artifact again.** ADR-0003's store needs that: a `main` image that seeds
   `tables/1.2.0` with code that differs from the released `1.2.0` would either overwrite a released
   artifact or fail its integrity check.
2. **It costs no npm publishes.**
3. **Graduation falls out of semver.** `^1.3.0-main.412` contains `1.3.0`. So an export can carry a
   snapshot pin to its release by default, and ADR-0003's fallback can do the same wherever a kept
   snapshot is missing. This needs two changes:
   - the fallback reads a snapshot's props from its own `metadata.json`, embedded in the export or
     held in the store, instead of the catalogue (see Decision);
   - the fetch skips registries for `-main.` pins (#806, #808).
4. **It is #798's rule applied to every package in the image.** The shared `<n>` ties a qadam
   snapshot to its platform build and its image.

### Option B — publish snapshots to npm, fetchable like releases

Rejected.
- **The cap.** Two commits in the last 31 days needed 142 and 177 publishes, roughly four to seven
  days of the cap each at 26–38 a day. Even a quiet day's snapshots would use up publishes that releases need.
- **Permanence.** npm never reuses a version number, so every snapshot stays part of each qadam's
  history.
- **Quarantine.** The worker's 3-day `minimumReleaseAge` quarantine would make a fresh snapshot
  uninstallable unless it were exempt. #482 item 3 added it
  (`packages/server/worker/src/lib/cache/qadams/qadam-installer.ts:62`, `:327`), and #806 carries
  the open exemption question.

All of that buys fetchability only for the instances that run `main`, which are ours.

### Option C — snapshots in a separate registry (OCI artifacts in GHCR), fetched by `-main` instances

Rejected for now. It needs:
- a second registry, and a catalogue channel for it;
- a signature scheme, because ADR-0003's npm-signature check does not apply;
- an `app-sec` review.

All of that would only cover a QA volume loss and QA-to-QA imports. An export that keeps snapshots
carries their metadata for the fallback, and a volume loss leaves the affected steps marked for a
person to update. Revisit when someone outside the team runs `:main`.

### Option D — "QA images are not release images": keep the last released number, flag or rewrite pins created on `-main` builds (#784 option 2 alone)

Rejected.
- **Silent code swaps.** One number would name different code from one `main` build to the next on
  the same instance. The store would have to accept conflicting content under one key, and a step
  published on build 410 would run build 412's code. That silent swap is what ADR-0003 exists to
  stop.
- **A new stored field anyway.** A pin does not record which build created it, so this option still
  needs a new field.
- **No basis for a rewrite.** A rewrite at release time has no metadata for the code the step was
  built on, so no props check is possible.

Its marking survives as the "pre-release build" label.

### Option E — the "published ≡ tested" check alone (#784 option 4)

Rejected as the answer; kept as gate 9. Under ADR-0001 every changed package differs from its
release until the release PR. As a gate on `main` it would be red permanently. As a gate on releases
only, it leaves QA pins unanswered.

### Option F — release train: release every changed package on every `main` build

Rejected. It contradicts ADR-0001: the release PR raises versions, and per-merge releases would make
every merge a release. It also runs into the cap, as in Option B.

### Option G — keep raising versions in each PR, or let CI commit snapshot versions back to `main`

Rejected.
- **ADR-0001.** The repository holds the last released version.
- **Committing back.** CI would need write access to `main`, and a push can loop into its own
  trigger (#494).
- **History.** Per-PR bumps are today's practice, and they still left 149 of `v1.1.0`'s 238 versions
  unfetchable.

### Sub-decisions inside Option A

| Question | Chosen | Rejected, and why |
| --- | --- | --- |
| Which packages get a snapshot | Those with their own pending changeset | Every in-repo dependent of a changed `framework` / `common`, as changesets' dependent bumps would do: up to 238 snapshots per SDK change, for code the platform provides anyway (ADR-0003) |
| `<next>` | Changesets' release plan at that commit | `0.0.0-<tag>-<datetime>` (changesets' snapshot default): `^0.0.0-…` is `<0.0.1`, so no release would ever satisfy it and the fallback could never graduate a pin. Always "patch of the last release": misstates a pending minor or major; it is used only in the fallback build below, where no plan is available |
| `<n>` | The platform prerelease counter of the same build (#798) | A commit hash: not ordered. A timestamp: does not identify the image. A per-package counter: needs state that survives across builds |
| Unchanged packages in a `main` image | The released artifact from the archive | A rebuild from the tree under the released number: different bytes under the same number whenever the toolchain or third-party dependencies drift (ADR-0003: never rebuilt from git) |
| Release plan or archive unavailable in a `main` build | Every package built from the tree as a snapshot, `<next>` the next patch, with a warning | Fail the build: QA gets no image while a build dependency is down. Unchanged packages rebuilt under their released number: two artifacts under one number (row above) |
| Pin format | `x.y.z` or `x.y.z-main.<n>`, through one parser in `shared` | Any semver prerelease: no build produces one, and the fallback and `follow` rules model only `-main.<n>`. One pattern per consumer (today): they already disagree (Context) |
| Alias | `name@version`, split at the last `@`; compatibility read for existing `name-version` workspace directories | `name-version` with a smarter split: a qadam name and a prerelease both contain hyphens, so the split has to guess where the version starts |
| Storage | The instance store; the `:sha-*` image as the archive of record | npm (B), a separate registry (C) |
| A snapshot pin in an export | Rewritten to the release caret range of its line; snapshots and their metadata kept only on explicit opt-in | Keep snapshots by default: production instances would import pins they can never fetch. Never keep them: QA-to-QA copies need them, because `^1.3.0` does not contain `1.3.0-main.420` |
| A snapshot pin on the instance that holds it | `AP_QADAM_SNAPSHOT_POLICY`: `follow` (default on `-main` instances) moves it inside the caret with ADR-0003's checks, an audit record and revert; `pin` (default on release instances) keeps it | Always keep (the 2026-10-08 draft): QA stops exercising `main` unless someone updates every step. Always follow: an instance that imported snapshot pins on purpose, for example to reproduce a QA run on a release instance, would have them moved. Moving release pins too: ADR-0003's rejected Option C |
| A snapshot pin where it is missing | ADR-0003's fallback, prereleases counted inside the caret, props from the snapshot's own `metadata.json` (embedded in the export or in the store); without metadata, marked | Exact releases only: on a `-main` instance a missing snapshot could then never move to the image's newer snapshot of a compatible line. No props check (the 2026-10-08 draft): the one place this ADR loosened ADR-0003 |
| Gate 9 | Measured first, advisory during the clean-up, required when the divergences reach zero and before `2.0.0` | Required from day one: every `main` image build would be red until all divergent `0.x` qadams have changesets. Report-only for good: unenforced checks are how #783 happened (ADR-0001). ADR-0001 rejected advisory-first for gates 1–7, which a PR can satisfy at once; gate 9 cannot pass until the divergences are released, and it joins the required set before the first release under ADR-0001 all the same |
| Store size | GC (#478), a store-size metric and an operator warning above a configurable threshold | A hard size limit: the store would have to drop pinned versions or refuse an image's seed, and either breaks ADR-0003 |
| Framework drift under a snapshot | Accepted; the store records the framework version each snapshot was built against, and audit records and the census show it | Freezing the framework per snapshot: the per-version library copies ADR-0003 rejected (its Option E) |

## Consequences

**Easier.**
- Every image keeps the rule that a version names one artifact, so ADR-0003's store holds without
  exceptions.
- A step never runs other code under the same number. Under `pin`, a QA flow keeps running the code
  it was built on across `main` deployments. Under `follow`, it moves with checks, an audit record
  and revert, never under the same number. The #411 / #432 class of stranded and silently swapped
  steps ends there too.
- Release instances get release pins from exports by default.
- Snapshots cost no npm publishes.
- #494 gets its number and its counter, and the canary (#116) inherits all of it.

**Harder, new obligations, and how each is answered.**
- **The stored-flow contract widens.** Pins accept `x.y.z-main.<n>`. The alias format and the
  engine's same-version match must handle a prerelease. A platform older than that change rejects a
  flow with a snapshot pin on import, and could not run it anyway. *Answer:* only `-main.<n>` and no
  other prerelease, decided by one parser in `shared` (Decision, "Pin format"). The alias moves to
  `name@version`, with a compatibility read for the worker's existing `name-version` directories.
  Exports carry release pins unless someone opts in, so the wider contract reaches release instances
  only on purpose.
- **QA flows would stop following `main`.** In the 2026-10-08 draft a step stayed on its snapshot
  until someone updated it. *Answer:* `AP_QADAM_SNAPSHOT_POLICY=follow`, the default on `-main`
  instances. The cost is that on QA a published flow's code changes between deployments, visibly in
  the audit record and revertibly. Two limits remain:
  - a step pinned to a release does not follow;
  - a fallback build's numbers can order below an earlier planned snapshot
    (`1.2.1-main.413` < `1.3.0-main.412`), and `follow` then leaves the step where it is.
- **`main` image builds depend on more.** They need changesets' release plan (#796) and, for
  bundle-format qadams, the release archive (#804). *Answer:* without either, the build falls back
  to snapshots of every package and warns (Decision). That has three costs:
  - **Storage.** A fallback image seeds up to 238 snapshots, about 340 MB at the prototype's
    ~1.4 MB average. GC can collect them only 10 days after the next image stops shipping them.
  - **An understated `<next>`.** It understates a pending minor or major, but never brings a
    breaking release inside the caret. On `1.x` the caret of `1.2.1-main.<n>` ends below `2.0.0`; on
    `0.x` the caret of `0.4.17-main.<n>` ends below `0.5.0`.
  - **An exported pin that may never resolve.** An export rewrites such a pin to a patch that may
    never be released, and the importing instance then marks the step.

  Changesets that cannot be parsed still stop the build earlier: the platform's own version is
  fail-closed (`tools/ci/compute-main-version.mjs:32`, `:53-58`). So in practice the fallback covers
  the archive, and a release-plan step that cannot run.
- **No wider exception in ADR-0003's fallback.** The 2026-10-08 draft extended ADR-0003's
  no-metadata path, load check only, to every future snapshot pin. *Answer:* withdrawn. A snapshot
  pin moves only after the props check, on metadata embedded in the export or held in the store.
  Without metadata the step is marked. The costs:
  - after a QA volume loss, or an import of an export without metadata, a person updates the
    affected steps;
  - the export format carries metadata, which the importer treats as untrusted input.
- **Store growth.** On `-main` instances the store keeps every snapshot a flow pins. A qadam artifact
  with its third-party dependencies averaged ~1.4 MB in the ADR-0003 prototype (337 MB / 235).
  Unpinned snapshots are collected 10 days after an image stops shipping them. *Answer:* GC (#478) as
  ADR-0003 fixes it. Under `follow`, GC also keeps a snapshot that an audit record can still revert
  to. The store reports its size as a metric and warns the operator above a configurable threshold
  (for example 5 GB).
- **Clean-up before gate 9 can be required.** The gate fails every build, `main` included, for a
  `0.x` qadam whose tree build differs from npm and has no changeset. At `v1.1.0`, 46 qadams differed
  from npm under the same version (ADR-0001; `schedule@0.1.17`'s `ru.json` is its example); today's
  count is not measured. A changeset makes each one a `-main.<n>` build, which passes, and the release
  that publishes them is bounded by the cap: 46 at 26–38 a day is about two days. *Answer:* a
  measurement script first, then the gate runs advisory while the changesets land in batches and the
  releases are spread under the cap. It turns required when the divergences reach zero, and before
  `2.0.0`.

**Irreversible.** Stored flows on `-main` instances will carry prerelease pins, and later releases
must keep reading them. *Answer:* exports rewrite snapshot pins unless someone opts in, so the
obligation stays with the instances that run `main` and the flows sent from them on purpose.

**Accepted limitation.** As in ADR-0003, a snapshot runs on the platform's framework, so a behaviour
change in `framework` / `common` changes it too. ADR-0002 governs framework breaks, through majors and
the support window; inside a major, a snapshot can still behave differently on a later image. The
store records the framework version each snapshot was built against, and audit records and the
census (ADR-0002) show it, so such a difference can be traced to its cause.

**Ordering.** Before changesets (#796), PRs raise versions themselves and this ADR changes nothing.
It takes effect with the first changesets release PR, the same moment as ADR-0001's gates. Gate 9
runs advisory from the measurement on, and turns required when the `0.x` divergences reach zero,
before the `2.0.0` release.

## Evidence

All on `origin/main` @ `af659857`, 2026-10-08, except the amendment of 2026-10-10, whose code
citations are at `8ba81dfa` and say so.

- **npm versions.** `npm view @aiqadam/qadam-tables versions time` returns `0.0.0-stage` and `0.5.1`
  only. `git show <commit>:packages/qadams/core/tables/package.json` gives `0.4.6` at `288c3d18`
  (2026-09-24) and `0.5.0` from `9f2983f3` (2026-09-29) to `566f4c10` (2026-10-04).
- **`v1.1.0` against npm.** `name@version` was read from all 238 `packages/qadams/{core,community}/*/package.json`
  at tag `v1.1.0`, then each one was checked against the registry's version list
  (`registry.npmjs.org`, abbreviated metadata). Result: 149 absent, 89 present.
- **Change volume.** `git log origin/main --first-parent --since=2026-09-08` over
  `packages/qadams/{core,community}/*/src/**`: 30 commits and 365 (qadam, commit) pairs, with 177 in
  `f6462939` and 142 in `bf7857ae`. Over all paths with
  `--until=2026-10-08T23:59`, counted per calendar day over 31 days: 228 commits, mean 7.4, median
  5 (6 over the 28 days with commits), maximum 30.
- **Semver behaviour.** With `semver` 7.6.0, the version the repository uses:
  - `satisfies('1.3.0', '^1.3.0-main.412')` and `satisfies('1.3.1', '^1.3.0-main.412')` are true;
  - `satisfies('1.3.0-main.420', '^1.2.1-main.412')` is false, and true with `includePrerelease`;
  - `satisfies('2.0.0-main.500', '^1.2.1-main.412', {includePrerelease: true})` is false;
  - `compare('2.1.0-main.5', '2.1.0')` is −1;
  - added 2026-10-10: `subset('^1.3.0', '^1.3.0-main.412')` and `subset('^0.4.17', '^0.4.17-main.412')`
    are true; `satisfies('1.3.0-main.420', '^1.3.0', {includePrerelease: true})` is false;
    `compare('1.2.1-main.413', '1.3.0-main.412')` is −1.
- **Changesets.** `changeset version --snapshot` defaults to `0.0.0-{tag}-{datetime}`. With
  `snapshot.useCalculatedVersion` it uses the planned version. `prereleaseTemplate` offers `{tag}`,
  `{commit}`, `{timestamp}` and `{datetime}`, and no CI counter, so `<n>` has to come in through
  `{tag}` (`docs/config-file-options.md` in changesets/changesets, `@changesets/cli` 3.0.3).
- **Image archive.** The anonymous GHCR tag list for `ghcr.io/aiqadam/qadam-flow` shows 335 tags,
  328 of them `sha-*`. No workflow in `.github/workflows/` deletes package versions; `cleanup.yml`
  deletes workflow runs only.
- **What the store records today** (at `8ba81dfa`). `integrity.json` has no framework field
  (`packages/server/utils/src/qadam-version-store/qadam-version-store-read.ts:184-203`). A bundle's
  `package.json` carries `^<version>` of the tree's `qadams-framework` as a peer range, not the
  exact build (`tools/scripts/qadams/bundle/qadam-artifact.mjs:418-430`). The store parses
  `metadata.json` with a loose schema and a 32 MiB limit
  (`packages/server/utils/src/qadam-version-store/qadam-version-store-format.ts:97`, `:128-133`).

## Follow-ups

- **Prerelease pins.** One version parser in `shared` that accepts `x.y.z` and `x.y.z-main.<n>`. It
  replaces `VersionType` / `ExactVersionType`'s patterns for pins, `PLATFORM_RELEASE_PATTERN` (#828),
  the engine's `EXACT_VERSION_PATTERN`, the shared `EXACT_VERSION_REGEX` the worker and the metadata
  service import, and the store's coordinate check. The custom-qadam install schema keeps `x.y.z`.
  The alias becomes `name@version`, with a compatibility read for existing `qadams/<name>-<version>`
  workspace directories. A workspace member's `package.json` `name` must stay a valid package name,
  which `name@version` is not. Add fixtures for stored-flow validation, import and the same-version
  match.
- **Snapshot versioning in the `main` build.** Compute `<next>` from changesets' release plan for
  packages with their own pending changeset, and take `<n>` from #798. Write the result into each
  built artifact's `package.json` and `metadata.json`, and record `<n>` → commit in an image label.
  When the plan or the archive is unavailable, build every package as a snapshot with the next patch
  as `<next>` and log a warning; a release build fails instead.
- **Image assembly.** Unchanged bundle-format qadams come from the release archive (#804), and `0.x`
  qadams are built from the tree.
- **Gate 9** with fixtures (#797). Steps:
  - a script that lists the `0.x` divergences on `main`;
  - the gate runs advisory while their changesets merge in batches and their patch releases are
    planned against the cap;
  - the gate becomes required when the list is empty, before the `2.0.0` release.
- **Fetch (#806).** Do not try a registry for a `-main.` pin; go straight to the fallback.
  **Fallback (#808).** Count prereleases inside the caret. Read a snapshot pin's props from its
  `metadata.json`, embedded in the imported flow or held in the store. Without it, mark the step and
  do not move it.
- **Export and import.** In `flowService.getTemplate`, rewrite snapshot pins to `^<x.y.z>` by default.
  Add an explicit opt-in that keeps them in the UI export and `ap_export_flow`, and embeds each kept
  snapshot's `metadata.json`; that is a new optional field in the exported template. The importer
  validates the field as untrusted input.
- **Snapshot policy.** `AP_QADAM_SNAPSHOT_POLICY` (`follow` | `pin`), defaulting by whether the
  platform version is a `-main.<n>` prerelease, and documented under `docs/install/configuration/`.
  `follow` runs when the instance starts on a new image and uses #808's checks, audit record and
  revert.
- **Store (#478).** GC keeps a snapshot an audit record can still revert to. Add a store-size metric
  and an operator warning above a configurable threshold. Record each snapshot's exact framework
  version in the store, and show it in audit records and the framework census (ADR-0002).
- **UX.** A "pre-release build" label in the builder, MCP (`ap_flow_structure`, `ap_validate_flow`)
  and runs, and "update available" pointing at the release.
- **#494.** The SDK prerelease channel uses `<next>-main.<n>` with the same `<n>`, for
  `qadams-framework` and `qadams-common` only, on a dist-tag other than `latest`.
- **#796.** Expose the release plan to the image build, with each package's own changesets kept
  apart from dependent bumps, so the build can tell which qadams need a snapshot.
- **#798.** Move `ListQadamsRequestQuery` / `RegistryQadamsRequestQuery`'s `release` onto the shared
  parser. Decide how `isSupportedRelease` treats a floor equal to `<next>`.
- **Conventions.** A paragraph in `.agents/rules/versioning.md` (#800), and correct
  `.agents/features/ci-cd.md` on where `:main` is deployed.
- Close #784 against this ADR once it is accepted.

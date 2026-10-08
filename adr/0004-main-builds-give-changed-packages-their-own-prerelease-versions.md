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
set, the platform's `-main.<n>` prerelease) and ADR-0003 (the versioned store, release artifacts
archived and never rebuilt, the catalogue, the unavailable-version fallback, GC).

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

**Storage.** A qadam snapshot is stored where the flows that pin it run. The image seeds it into the
instance's store like any other version, and the store's GC already keeps every pinned version,
drafts included (ADR-0003, #478). Qadam snapshots are **not published** to npm or to any other
registry, and they are not in the catalogue. The SDK exception is below. The archive of record for a snapshot is the image that introduced
it: `:sha-<commit>`, whose platform reports `-main.<n>` with the same `<n>`.

**Where a snapshot is missing.** This covers another instance that imported the flow, and this
instance after losing its volume. The pin is an unavailable version under ADR-0003. Its caret range
contains the release of the same line (`^1.3.0-main.412` contains `1.3.0`). Prereleases count inside
the caret, so on a `-main` instance the target can also be the image's newer snapshot of a
compatible line.

ADR-0003 moves an unavailable pin only when the catalogue shows the target's props are compatible.
Its weaker path, with no props check and only a load check, audit record and revert, covers only
pins older than the first publication. A snapshot has no catalogue entry, so under ADR-0003 as
written it could never move. **This ADR extends ADR-0003's no-metadata path to snapshot pins.** That
is acceptable for three reasons:
- snapshot pins originate only on instances running our `main` images;
- the target is inside the pin's caret range, the same bound ADR-0001 promises is a drop-in
  replacement at the contract level. Every build on the way there passed gate 2's declared-level
  check (ADR-0001), which is what ADR-0003 also relies on to move a step (ADR-0003, "New
  obligations");
- the alternative is a manual "update this step" on every imported QA flow.

If no move is possible, the step is marked "update this step".

**On the instance that holds the snapshot**, nothing rewrites a pin. Steps pinned to a prerelease
are labelled "pre-release build" in the builder, MCP and runs. The existing "update available" path
offers the release once one is in range.

**The SDK.** Only `qadams-framework` and `qadams-common` may go to npm as `-main.<n>`, under a
dist-tag other than `latest`. That is #494's prerelease channel. This ADR fixes its number; #494
sets its rate inside the npm cap.

This ADR adds **gate 9** to ADR-0001's required set. Every qadam in an image is either its released
artifact or carries a `-main.<n>` version. For bundles, "released artifact" means it matches the
integrity the catalogue records. For `0.x` qadams it means their own code and metadata match the npm
tarball. A release build contains released artifacts only. The gate becomes required once the
existing `0.x` divergences have changesets (see Consequences).

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

**Prereleases are rejected everywhere a pin goes today** (at `af659857`):
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

## Options considered

### Option A — snapshot versions for changed packages, kept in the instance store; gate 9; prerelease label (chosen)

Option 1 of #784, without its "fetchable like releases" half, plus option 4 as a gate and the useful
part of option 2 as UX. It wins on four counts:
1. **One number names one artifact again.** ADR-0003's store needs that: a `main` image that seeds
   `tables/1.2.0` with code that differs from the released `1.2.0` would either overwrite a released
   artifact or fail its integrity check.
2. **It costs no npm publishes.**
3. **Graduation falls out of semver.** `^1.3.0-main.412` contains `1.3.0`, so ADR-0003's fallback
   can carry a snapshot pin to its release wherever the snapshot is missing. This needs two
   changes:
   - the fallback's no-metadata path is extended to snapshot pins (see Decision);
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

All of that would only cover a QA volume loss and QA-to-QA imports, which the fallback already
handles. Revisit when someone outside the team runs `:main`.

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
| `<next>` | Changesets' release plan at that commit | `0.0.0-<tag>-<datetime>` (changesets' snapshot default): `^0.0.0-…` is `<0.0.1`, so no release would ever satisfy it and the fallback could never graduate a pin. Always "patch of the last release": misstates a pending minor or major |
| `<n>` | The platform prerelease counter of the same build (#798) | A commit hash: not ordered. A timestamp: does not identify the image. A per-package counter: needs state that survives across builds |
| Unchanged packages in a `main` image | The released artifact from the archive | A rebuild from the tree under the released number: different bytes under the same number whenever the toolchain or third-party dependencies drift (ADR-0003: never rebuilt from git) |
| Storage | The instance store; the `:sha-*` image as the archive of record | npm (B), a separate registry (C) |
| A snapshot pin on the instance that holds it | Kept, labelled "pre-release build" | An automatic rewrite to the release: changes the code under a published flow, the objection that rejected ADR-0003's Option C |
| A snapshot pin where it is missing | ADR-0003's fallback, prereleases counted inside the caret | Exact releases only: on a `-main` instance a missing snapshot could then never move to the image's newer snapshot of a compatible line |
| Gate 9 | Required on `main` and release builds, once the existing `0.x` divergences have changesets (see Consequences) | Report-only: unenforced checks are how #783 happened (ADR-0001) |

## Consequences

**Easier.**
- Every image keeps the rule that a version names one artifact, so ADR-0003's store holds without
  exceptions.
- A flow on QA keeps running the code it was built on across `main` deployments. The #411 / #432
  class of stranded and silently swapped steps ends there too.
- Snapshots cost no npm publishes.
- #494 gets its number and its counter, and the canary (#116) inherits all of it.

**Harder, and new obligations.**
- **The stored-flow contract widens.** Pins and installs accept `x.y.z-main.<n>`. The alias format
  and the engine's same-version match must handle a prerelease. A platform older than that change
  rejects a flow with a snapshot pin on import, and could not run it anyway.
- **QA flows stop following `main` on their own.** A step stays on its snapshot until someone
  updates it, so exercising new code on QA means updating steps.
- **`main` image builds depend on more.** They need changesets' release plan (#796) and, for
  bundle-format qadams, the release archive (#804).
- **A wider exception in ADR-0003's fallback.** ADR-0003 allowed the no-metadata path only for pins
  older than the first publication. This ADR extends it to every future snapshot pin. A missing
  snapshot therefore moves without a props check, guarded only by the load check, the audit record
  and revert.
- **Store growth.** On `-main` instances the store keeps every snapshot a flow pins. A qadam artifact
  with its third-party dependencies averaged ~1.4 MB in the ADR-0003 prototype (337 MB / 235).
  Unpinned snapshots are collected 10 days after an image stops shipping them.
- **Clean-up before gate 9 can be required.** The gate fails every build, `main` included, for a `0.x`
  qadam whose tree build differs from npm and has no changeset. At `v1.1.0`, 46 qadams differed from
  npm under the same version (ADR-0001; `schedule@0.1.17`'s `ru.json` is its example); today's count
  is not measured.
  - Required on `main` from day one, it would turn `main` image builds red until those qadams have
    changesets. A changeset makes each one a `-main.<n>` build, which passes.
  - The release that publishes them is bounded by the cap: 46 at 26–38 a day is about two days.
  - So the divergences are listed and given changesets first, and the gate turns required after
    that.

**Irreversible.** Stored flows on `-main` instances will carry prerelease pins, and later releases
must keep reading them.

**Not covered.** As in ADR-0003, a snapshot runs on the platform's framework, so a behaviour change in
`framework` / `common` changes it too.

**Ordering.** Before changesets (#796), PRs raise versions themselves and this ADR changes nothing.
It takes effect with the first changesets release PR, the same moment as ADR-0001's gates. The
exception is gate 9's required status, which waits for the `0.x` clean-up (see Consequences).

## Evidence

All on `origin/main` @ `af659857`, 2026-10-08.

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
  - `compare('2.1.0-main.5', '2.1.0')` is −1.
- **Changesets.** `changeset version --snapshot` defaults to `0.0.0-{tag}-{datetime}`. With
  `snapshot.useCalculatedVersion` it uses the planned version. `prereleaseTemplate` offers `{tag}`,
  `{commit}`, `{timestamp}` and `{datetime}`, and no CI counter, so `<n>` has to come in through
  `{tag}` (`docs/config-file-options.md` in changesets/changesets, `@changesets/cli` 3.0.3).
- **Image archive.** The anonymous GHCR tag list for `ghcr.io/aiqadam/qadam-flow` shows 335 tags,
  328 of them `sha-*`. No workflow in `.github/workflows/` deletes package versions; `cleanup.yml`
  deletes workflow runs only.

## Follow-ups

- **Prerelease pins.** Widen `VersionType` / `ExactVersionType` to accept `-main.<n>`, change the
  alias format so a prerelease survives `trimVersionFromAlias`, and update the engine's
  `EXACT_VERSION_PATTERN` and the shared `EXACT_VERSION_REGEX` the worker imports. Add fixtures for stored-flow
  validation, import and the same-version match. This shares the `release` schema change with #798.
- **Snapshot versioning in the `main` build.** Compute `<next>` from changesets' release plan for
  packages with their own pending changeset, and take `<n>` from #798. Write the result into each
  built artifact's `package.json` and `metadata.json`, and record `<n>` → commit in an image label.
- **Image assembly.** Unchanged bundle-format qadams come from the release archive (#804), and `0.x`
  qadams are built from the tree.
- **Gate 9** with fixtures, in the required set (#797). Before making it required, list the `0.x`
  divergences it finds on `main` and merge their changesets, otherwise `main` image builds turn red.
  Then plan their patch releases against the cap.
- **Fetch (#806).** Do not try a registry for a `-main.` pin; go straight to the fallback.
  **Fallback (#808).** Count prereleases inside the caret, and extend the no-metadata path to
  snapshot pins, which ADR-0003 limited to pins older than the first publication.
- **UX.** A "pre-release build" label in the builder, MCP (`ap_flow_structure`, `ap_validate_flow`)
  and runs, and "update available" pointing at the release.
- **#494.** The SDK prerelease channel uses `<next>-main.<n>` with the same `<n>`, for
  `qadams-framework` and `qadams-common` only, on a dist-tag other than `latest`.
- **#796.** Expose the release plan to the image build, with each package's own changesets kept
  apart from dependent bumps, so the build can tell which qadams need a snapshot.
- **#798.** Accept a prerelease platform version in `ListQadamsRequestQuery` /
  `RegistryQadamsRequestQuery`. Decide how `isSupportedRelease` treats a floor equal to `<next>`.
- **Conventions.** A paragraph in `.agents/rules/versioning.md` (#800), and correct
  `.agents/features/ci-cd.md` on where `:main` is deployed.
- Close #784 against this ADR once it is accepted.

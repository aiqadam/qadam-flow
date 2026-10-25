# #778 — qadam version catalogue: what's done, what's left, and why the rest isn't buildable yet

**Status:** publishing and the `get()`/`list()` wiring remain blocked (see below). A follow-up
commit on this branch implemented the one piece ADR-0003 requires that was still missing and was not
blocked on anything: the catalogue address is now configurable (`AP_QADAM_VERSION_CATALOGUE_URL`,
`AP_QADAM_VERSION_CATALOGUE_DIRECTORY`), so a mirror or a local snapshot can be read without a code
change. That is the extent of the code in this pass.
**Investigated:** 2026-10-25, on `origin/main` (`97a61649`).

## What the ticket asks for, today

#778 was re-scoped by [ADR-0003](../../adr/0003-official-qadams-run-from-a-versioned-local-store.md)
([issue comment](https://github.com/aiqadam/qadam-flow/issues/778#issuecomment-6066247726),
2026-10-08): a static JSON catalogue of every released version of every official qadam, with
tarball integrity, published on GitHub Pages. That comment left three open questions to settle "in
the implementation":

1. the API reads the catalogue and the store for builder, MCP and validation of an old version
   (#411, #422 — both closed, they're the symptom issues this answers);
2. `list()`'s "latest" semantics when several OFFICIAL versions of a qadam are known;
3. what `findBundledFallback` becomes once catalogue/store history exists.

## What's already done

PR #830 (merged 2026-10-09, "Part of #778, not Closes") built the catalogue itself:
`packages/server/api/src/app/qadams/catalogue/` — format, a release-time writer, and a reader,
all with tests. See [`.agents/features/qadam-version-catalogue.md`](../../.agents/features/qadam-version-catalogue.md)
for the format and the reader/writer contract; it isn't repeated here.

More has landed since that PR than its own "what is left" section suggested, and more than the
feature doc said before this pass:

- **The reader is wired at run time**, in two places, both read-only and both fail closed on an
  unreadable catalogue (never act on "unknown"):
  - `snapshotExportSources` (`packages/server/api/src/app/qadams/snapshot-export/snapshot-export-sources.ts`),
    built for ADR-0004's flow export (#853, PR #880): a release's `metadata.json` comes from the
    catalogue, a snapshot's from the version store.
  - `qadamPinFallbackSeams` (`packages/server/api/src/app/qadams/pin-moves/qadam-pin-fallback-seams.ts`),
    built for #808's first slice (PR #882): the props-compatibility check an unavailable-pin move
    needs reads two catalogue entries' metadata through the same sources.
- **Question 3 is effectively answered.** `findBundledFallback` in `qadam-metadata-service.ts`
  still exists and still plays its original role (the registry's run-time net for an inexact pin
  with nothing else to offer), but the *audited, reversible* replacement ADR-0003 asks for exists
  too: #808's `qadamPinMoveService` moves a step at publish time, with a caret check, the
  catalogue-backed props check above, and a load check, each recorded so it can be reverted. See
  [`.agents/features/qadam-pin-moves.md`](../../.agents/features/qadam-pin-moves.md).

Both consumers already name the gap explicitly in their own comments: *"The catalogue's default
address answers 404 until #778 publishes it"* (`qadam-pin-fallback-seams.ts:24`,
`qadam-pin-moves.md:31`). That is the one piece left that is actually #778's own to deliver.

## What's left, and why none of it is safe to build right now

### Publishing the catalogue — blocked on a maintainer decision, not on code

The feature doc's "Open questions" section already named this before this pass: credentials for
the `aiqadam/qadam-flow` release workflow to push to `aiqadam/flow.aiqadam.org`, and the release
job that calls the writer. Checked against #804 (the artifact format the writer consumes) directly:

> "Remaining: Publish pipeline: ship the bundle format to npm... Archive the artifacts at release
> time... The publish-pipeline and release-archive items are **not** touched — they need a
> maintainer decision on the 1.0.0 cut." — [#804](https://github.com/aiqadam/qadam-flow/issues/804),
> comment 2 (the build itself, and its CI wiring, are done per #890; the two items that would let
> a release actually produce catalogue-ready artifacts are explicitly withheld for a maintainer
> call)

Writing the release-workflow YAML now would be premature for the same reason PR #830 gave for not
writing it then: releases still publish `0.x` qadams in the legacy npm format, and the writer only
accepts #804's bundle-format artifacts (`qadam-version-catalogue-writer.ts`'s `ArtifactPackageJson`
schema requires a `qadamArtifact.formatVersion` field no legacy npm tarball carries). Appending
today's actual release output would either be rejected outright or — if the schema were loosened to
let it through — would record an integrity npm does not serve for the one format that *is* being
released. Building a parallel `legacy-npm` producer (computing a published tarball's integrity,
plus metadata by loading the installed package) is the other option ADR-0003 and the feature doc
name, and it depends on #806's "legacy install path," which does not exist yet: no code anywhere
in `api`/`worker`/`engine` installs an *official* npm package and extracts its metadata outside the
platform-install-time flow (`qadamInstallService`), and that flow explicitly refuses official names
(`qadam-metadata-service.ts:225`, `qadam-install-service.ts:37`, both citing #503). Building a
second, parallel metadata-extraction path for this one script risks exactly the "two sources that
can drift" failure ADR-0003 rejected npm-per-version install for in the first place (Option B).

### `get()` / `list()` wiring (questions 1 and 2) — not reachable, so not safely buildable

Checked directly against the current `qadam-metadata-service.ts` and the version store:

- `get()` resolves only through the registry (bundled manifest + `qadam_metadata` DB rows,
  `findExactVersionFor`) and, for an inexact pin with no match, `findBundledFallback`. It never
  reads the version store or the catalogue.
- `list()` → `fetchLatestQadams` merges DB rows and the bundled manifest, then takes the highest
  semver per name (`lastVersionOfEachQadam`). Same two sources, same gap.
- The version store (#805, `packages/server/utils/src/qadam-version-store/`) has exactly one
  writer: `qadamVersionStoreSeed.seedFromImage`, called only from
  `packages/server/api/src/app/qadams/version-store/qadam-version-store-seeding.ts` at API boot.
  It seeds from the current image's own bundled tarballs — nothing else populates it. `#806`
  (fetch at publish/import/start-up) and `#808`'s step-move are the two things that would ever put
  a *different* version into the store than the image already bundles, and neither is wired to
  write to it yet (#808's first slice only reads the store/catalogue for its decision; it does not
  write).
- The other way a second OFFICIAL version of the same qadam could exist — a `qadam_metadata` row
  surviving next to the bundled version — is gated behind `OFFICIAL_QADAMS_INSTALL_ENABLED`
  (`qadam-cache.ts`), still hardcoded `'false'` in `system.ts`. #482, the dependency-confusion
  precondition its comment names, is now closed — but the flag still shouldn't be read as "almost
  ready": it switches on #433's *first* mechanism (install every official version from npm,
  `qadamInstallService`), which is exactly the Option B ADR-0003 rejected in favour of the
  versioned store this issue feeds. Turning it on would reintroduce the per-version `shared`/
  `framework`/`common` duplication ADR-0003 measured at ~41 MiB per extra copy (#772) — the
  problem the store exists to avoid. Nothing suggests this flag is on a path to ever flip now.

Put together: on every instance running this code today, the store and the catalogue can only ever
describe the same version the bundled manifest already does. There is no reachable input on which
`get()` or `list()` would behave differently if they read the catalogue or the store — they would
be exercised by zero tests that aren't fakes of a future world, and zero real traffic. Writing that
code now is the "no half-finished implementations" and "don't design for hypothetical future
requirements" failure mode the house conventions warn against, not a head start: it would need
re-verifying against #806's actual shape once that lands anyway (what "fetched but not yet
installed" looks like from `get()`'s point of view isn't decided, and shouldn't be guessed at here).

## What this work did

- Implemented the configurable catalogue address ADR-0003 requires ("the URL is configurable for
  mirroring"): `AP_QADAM_VERSION_CATALOGUE_URL` selects a mirror, and
  `AP_QADAM_VERSION_CATALOGUE_DIRECTORY` selects a local copy and takes precedence. The resolver in
  `snapshot-export-sources.ts` is the single binding both run-time consumers use, so flow export and
  the pin-fallback seam pick it up together. Tests cover the directory override, its precedence over
  the URL, and the default address.
- Corrected [`.agents/features/qadam-version-catalogue.md`](../../.agents/features/qadam-version-catalogue.md):
  it previously said "nothing at run time calls the reader," which stopped being true once #853/#880
  and #808's first slice (#882) landed. Updated the open-questions section to match: question 3 is
  answered, questions 1 and 2 are open but not actionable yet, for the reasons above.
- Corrected the operator-facing page,
  [`docs/install/architecture/qadam-version-catalogue.mdx`](../../docs/install/architecture/qadam-version-catalogue.mdx),
  which still said nothing reads the catalogue, and documented both variables in
  [environment-variables](../../docs/install/configuration/environment-variables.mdx).
- This doc, as the record of why no catalogue/store wiring or publish-workflow code went into this
  pass.
- A comment on #778 itself, pointing at this doc, so the next person to pick up the issue (likely
  after #804's publish-pipeline decision or #806 lands) starts from the current state instead of
  re-deriving it.

## Recommended next step

#778 should stay open, scoped to exactly one remaining deliverable: the release-workflow job that
calls the writer and pushes to `aiqadam/flow.aiqadam.org`, plus whatever `legacy-npm` producer that
needs. Both need #804's publish-pipeline maintainer decision first (and, for the legacy producer,
#806's install path). Nothing else under #778's own heading is blocked on anything but those two
calls.

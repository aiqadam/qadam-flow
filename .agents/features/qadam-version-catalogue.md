# Qadam Version Catalogue

## Summary
ADR-0003's catalogue (#778): static JSON describing **every released version of every official
qadam**, each with the integrity of the artifact that was released and the version's own
`metadata.json` from #804. It gives an instance metadata for versions its image does not ship, which
#806 (fetch, merged — PR #969) and #808 (the unavailable-version fallback's props check, merged —
PR #882) read already. Published as static files on GitHub Pages under
`https://flow.aiqadam.org/catalog/v1/`,
appended to by releases, never rewritten. Where the API reads it is configurable, for mirroring
(`AP_QADAM_VERSION_CATALOGUE_URL`) and for a local copy (`AP_QADAM_VERSION_CATALOGUE_DIRECTORY`,
which wins over the URL — for an air-gapped mirror).

**Format and reader done; hosting not done.** The format, the release-time writer and the API
reader exist, with tests (#830). Two consumers now call the reader at run time: flow export's
`snapshotExportSources` (ADR-0004, #853/#880 — a release's `metadata.json` for a pin export may
rewrite to) and #808's pin-fallback seam (`qadamPinFallbackSeams`, first slice in #882 — the
props-compatibility check a caret-range pin move needs). Both read through the same configured
source (the published URL by default) and treat an unreadable catalogue as *unknown*, never as a reason to act — the fail-closed
design ADR-0003 asks for. What is still missing is the other half: **no release workflow calls the
writer, and nothing is published at the default URL**, so on a real instance both consumers read a
404 today and every release-era pin is "unknown" (stays put). #807 (images/registry at install)
deliberately does **not** bake a catalogue snapshot into either image, despite "carries a snapshot"
being in that issue's original scope: the only way to produce one inside a Docker build — with no
release step anywhere that first checks out the already-published catalogue — is from scratch, and
a from-scratch snapshot can only ever hold this tree's current version of each qadam, never "every
released version". `qadamPinFallbackSeams`'s `readPinMetadata` (below) treats an older pinned
version that is merely absent from a catalogue with zero skipped entries as proof the version was
"never published" — exactly the wrong call against such a snapshot, for any qadam with more than one
released version. #807's own issue thread said as much: "Seed only after #851 lands (or ships in the
same change)" — #851's snapshot-plan computation exists but, per `.agents/rules/versioning.md`, "the
image does not apply it yet", so that gate was not met. See
[`docs/research/778-qadam-version-catalogue-status.md`](../../docs/research/778-qadam-version-catalogue-status.md)
for the full picture of what else is, and is not, safe to build before that lands.

The ticket's original options (persist each bundled version on API boot; extract metadata from the
registry artifact) are replaced by ADR-0003 (maintainer comment on #778, 2026-10-08): the catalogue
plus each stored version's `metadata.json` (#805) are the source of truth, and the metadata is the
artifact's own (#804), never re-derived.

## Key Files
- `packages/server/api/src/app/qadams/catalogue/qadam-version-catalogue-format.ts` — the format, shared by writer and reader: layout, zod schemas (lenient for readers, strict for the writer), `integrityOf`, deterministic `serializeIndex`, `QADAM_VERSION_CATALOGUE_DEFAULT_URL`, size bounds
- `packages/server/api/src/app/qadams/catalogue/qadam-version-catalogue.ts` — the reader: `qadamVersionCatalogue.read({ source })` → `names()`, `versions({ name })`, `entry(...)`, `readMetadata(...)`; never throws, every outcome is a status
- `packages/server/api/src/app/qadams/catalogue/qadam-version-catalogue-source.ts` — sources: `directory({ root })` (an image snapshot or a mirror on disk) and `http({ baseUrl, client? })` (through `safeHttp`)
- `packages/server/api/src/app/qadams/catalogue/qadam-version-catalogue-writer.ts` — `append({ catalogueDir, archiveDir })` and `verify({ catalogueDir })`
- `packages/server/api/src/scripts/append-qadam-version-catalogue.ts` — CLI for the writer; runs from source with `bun` (no API build needed) or from `dist/` with `node`
- `packages/server/api/test/unit/app/qadams/qadam-version-catalogue*.test.ts` — writer and reader tests, including the writer → reader contract and an HTTP source against a local server
- `docs/install/architecture/qadam-version-catalogue.mdx` — operator-facing page (format, hosting, mirroring)

## Format (schema 1)

```
<root>/index.json                               every qadam, every version
<root>/qadams/<name>/<version>/metadata.json    the artifact's metadata.json, byte for byte
```

`index.json`: `{ schemaVersion: 1, qadams: { <name>: { versions: { <version>: entry } } } }`. An entry:

| Field | Meaning |
| --- | --- |
| `artifact.format` | `bundle` (#804) or `legacy-npm` (a `0.x` version as npm received it) — the two formats the version store (#805) reads |
| `artifact.kind` | `bundle` or `bundle-with-node-modules` (bundle format only) |
| `artifact.integrity`, `artifact.size` | sha512 SRI and byte size of the released tarball — the file npm serves and the image seeds |
| `metadata.integrity`, `metadata.size` | sha512 SRI and byte size of the `metadata.json` file. Its path is derived from the name and version, never read from the index |
| `minimumSupportedRelease`, `maximumSupportedRelease` | copied from the metadata, so `isSupportedRelease` filtering needs no metadata fetch |
| `commit` | the commit the artifact was built from (#804's archive index) |

- **Coordinates.** Names are official only (`@aiqadam/qadam-*`, npm grammar); versions are canonical
  semver without build metadata. Both double as path segments.
- **Schema evolution.** `v1` in the URL is the schema major. Inside it only additive changes: a new
  optional field or a new enum value. Readers are lenient — unknown fields are dropped, an entry that
  does not parse is skipped and counted (`skippedEntries`), a wrong envelope is `invalid`, another
  `schemaVersion` is `unsupported`. The writer is strict: it refuses to append to an index carrying
  anything it does not know, because rewriting it would drop that silently. A change an old reader
  would misread goes to `catalog/v2/`, and `v1/` stays published for the releases that read it.
- **Determinism.** Names sorted, versions in semver order, fixed field order: re-running the writer
  with nothing new produces identical bytes.

## Writer (release pipeline)

```
bun packages/server/api/src/scripts/append-qadam-version-catalogue.ts --archive <804 out>/archive --catalogue <checkout>/catalog/v1
bun packages/server/api/src/scripts/append-qadam-version-catalogue.ts --verify --catalogue <checkout>/catalog/v1
```

Input is #804's `--pack` output — `archive-index.json` plus the npm tarballs, the archive of record
and the same input #805's seeding reads. Per artifact it recomputes the tarball's sha512 and size
against the archive index, reads `package/package.json` (must name the version and carry
`qadamArtifact.formatVersion: 1` of the declared kind) and `package/metadata.json` from inside the
tarball (`tar -xzOf -`, fed the tarball buffer whose integrity was just checked, never the file
again; each member is bounded, package.json at 1 MiB and metadata at 16 MiB), and checks the
metadata names the same qadam and version and carries its release floors as strings or not at all
(a `null` floor is refused: the index drops it, so the entry would disagree with its own file). It
refuses:
non-official names, non-canonical versions, **prerelease versions** (ADR-0004's `-main.<n>`
snapshots are never in the catalogue, and no other qadam prerelease channel exists), builds from a
dirty tree, unknown kinds, tarball names with a path, a version listed twice, and **a version already
in the catalogue with any field different** — artifact, kind, metadata or commit (a version is
never republished). One problem refuses the whole run and writes nothing; otherwise metadata files
are written (`wx`) and the index last by rename. It verifies the existing catalogue before appending.
Nothing is ever removed.

**Interrupted runs.** A re-run of the same archive finishes the job: a metadata file already in place
with the same bytes is reused, a different one is refused. That includes a first run that stopped
before writing any index. With no index, though, every file under `qadams/` must be one this run
adds; anything else means a catalogue lost its index, and a fresh index would drop every version it
listed, so the run is refused with the files named (restore `index.json`, or remove them if the
directory is meant to be a new catalogue).

## Reader (API)

`qadamVersionCatalogue.read({ source })` → `ok` (with `skippedEntries`) / `unavailable` / `invalid`
/ `unsupported`. `readMetadata({ name, version })` → `ok` / `not-in-catalogue` / `unavailable` /
`integrity-mismatch` / `invalid` (not metadata, or names another version). Bounds: index 32 MiB,
metadata 16 MiB. The HTTP source goes through `safeHttp.axios` by default (a mirror on a private
address needs `AP_SSRF_ALLOW_LIST`), at most 3 redirects, 30 s timeout, and never puts the URL in a
reason (a mirror URL may hold credentials). Both sources refuse a path that leaves their root. The
directory source checks that on real paths (`realpath` of root and target), so a symlink cannot lead
out; it opens with `O_NOFOLLOW | O_NONBLOCK`, so a FIFO cannot hang it, reads only a regular file,
and never reads past the size `fstat` reported (a file that changes while read is refused). An HTTP
body over the bound is `too large`, as it is from a directory.

**Trust model.** Metadata files are bound to the index by integrity. The index is trusted as far as
its source: HTTPS to the configured host, or the image's own snapshot. It is not signed. For
`@aiqadam/*` tarballs the catalogue's integrity is a consistency check, not the trust anchor: #806's
npm signature check is mandatory for them (ADR-0003 "Fetching").

## Hosting and publishing (designed, not deployed)

- **Host.** ADR-0003 fixes it: GitHub Pages under `flow.aiqadam.org/catalog/v1/`. `flow.aiqadam.org`
  is served by the repository `aiqadam/flow.aiqadam.org` (Pages source `main`, path `/`, CNAME
  `flow.aiqadam.org`, legacy Jekyll build — checked with `gh api repos/aiqadam/flow.aiqadam.org/pages`
  on 2026-10-09), which also serves `run.sh` and the landing page. The catalogue would be the
  directory `catalog/v1/` in that repository. `https://flow.aiqadam.org/catalog/v1/` answers 404 today.
- **Size.** Measured on the 238 current versions built with #804 (`--all --pack`, `627eda53`):
  metadata 6.8 MB raw (median 15 KB, max 372 KB), `index.json` 154 KB (38 KB gzipped). At ~240
  version bumps per 3.5 months (ADR-0003 Evidence) that is roughly 1,000 versions and 15–30 MB a year,
  far inside GitHub Pages' 1 GB site limit.
- **Publishing.** A release job: build and pack with #804 → check out `aiqadam/flow.aiqadam.org` →
  `append` into `catalog/v1/` → `verify` → commit and push. Two concurrent releases are serialised by
  the push (a rejected push re-checks-out and re-runs; the writer is idempotent). Pages caches for
  10 minutes, so a new version is visible within that.
- **Image snapshot — deliberately not built (#807).** See the Summary above for why a from-scratch,
  build-time-only snapshot is unsafe before a release step publishes the real catalogue. Neither
  flavour sets `AP_QADAM_VERSION_CATALOGUE_DIRECTORY`.
- **Mirroring.** Copy the whole tree; any static server works. The API reads the published URL by
  default; `AP_QADAM_VERSION_CATALOGUE_URL` points it at a mirror and
  `AP_QADAM_VERSION_CATALOGUE_DIRECTORY` at a local copy (which takes precedence and makes no
  request). Both are read once when an export or a pin move builds its sources.

## Open questions
- **Credentials to publish.** The release workflow of `aiqadam/qadam-flow` needs write access to
  `aiqadam/flow.aiqadam.org` (a deploy key or a fine-grained token in the release environment). Not
  created; a maintainer decision.
- **Jekyll.** The Pages site builds with legacy Jekyll. JSON files and `@aiqadam` directories are
  copied as they are, but every append triggers a Jekyll build; a `.nojekyll` file or an
  Actions-based deployment avoids that. It changes how the landing page builds, so it is the site
  owner's call.
- **When releases may append.** The catalogue must record the artifact that was actually released.
  Releases still publish `0.x` qadams in the legacy npm format (#804's publish switch is open), so
  appending #804 bundles today would record an integrity npm does not serve. Wire the append when
  the publish switch lands; until then, `legacy-npm` entries need their own producer (npm tarball
  integrity plus metadata from loading the published version, which #806's legacy install path
  produces).
- **Index signing.** Not required by ADR-0003. Worth deciding before a mirror is trusted for
  anything the npm signature does not cover.
- **The ticket's three questions.**
  - *`findBundledFallback`.* Its run-time net role is unchanged (`qadam-metadata-service.ts`'s
    `findExactVersionFor`), but the audited, checked replacement for a published flow now exists:
    #808's first slice (#882) moves a step at publish time, and its props check already reads the
    catalogue (`qadamPinFallbackSeams`, `.agents/features/qadam-pin-moves.md`). This question is
    answered, pending the catalogue actually being published.
  - *API reads the catalogue and the store for builder, MCP and validation of an old version
    (#411, #422).* The store part is implemented (#779): an exact official pin is answered from the
    stored version's `metadata.json` before the registry or the bundled build, and `registry` lists
    stored release versions. **Update (2026-11-07):** #806 merged (fetch at publish/import/start-up,
    PR #969), which was this bullet's own stated precondition for the catalogue half ("once #806 can
    fetch that version"). That precondition is now met, but it only unblocks the *design* question,
    not a safe mechanical wiring: `get`/`resolveVersions` is the hot path #879 added dedupe/caching
    for specifically because many tool pins hit it per flow, and the existing catalogue consumers
    (`snapshotExportSources`, `qadamPinFallbackSeams`) are both rare, one-shot calls (export, a pin
    move) that can afford a direct read with no cache of their own — wiring the same reader into this
    hot path without first giving it a TTL cache of its own (`storedQadamMetadata`'s pattern) risks a
    GitHub Pages round trip, or the configured mirror's, on every miss. Separately, a catalogue hit
    must be read-only *description* here (so #411/#422's symptom — an old step rendering with no
    name/icon — is fixed) and must not be read as "the worker can run this now": whether the version
    is actually fetched and safe to pin is still exactly #806 (publish/import/start-up) and #808's
    load/props/caret checks at move time, not this read path. Treating a catalogue entry as already
    runnable here would let the builder promise a version `get()` itself did nothing to fetch. Both
    points are implementation-shape decisions (where the cache lives, what "found in catalogue, not
    yet fetched" renders as to a caller), not leftover plumbing — worth a short design note before
    code, not a mid-session call.
  - *`list()` "latest".* The highest version this instance can run (image or store), not the
    catalogue's highest; catalogue-only versions appear in `listVersions` once #806 can fetch them.
    `list()` vs. `registry()` already encode this split on purpose: `list()` (the builder's "add a
    step" picker) takes the highest version per name from the registry and bundled manifest only — a
    version the store incidentally holds because one flow's exact pin fetched it is not a version to
    offer as the default for a brand-new step — while `registry()` (the full picker for pinning an
    existing step to a specific old version) already merges in every stored release (#779). No
    further code answers this question; it is closed by the existing split.

## Domain Terms
- **Qadam version catalogue** — this feature. Say "qadam version catalogue" (code:
  `qadamVersionCatalogue`): "catalogue" alone already means the list of qadams the builder shows
  (`fetchLatestQadams`, the bundled manifest's comments).
- **Catalogue entry** — one `name@version` in `index.json`.
- **Catalogue snapshot** — a copy of `catalog/v1/` inside an image. Deliberately not built by
  #807 — see the Summary.

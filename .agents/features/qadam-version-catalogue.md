# Qadam Version Catalogue

## Summary
ADR-0003's catalogue (#778): static JSON describing **every released version of every official
qadam**, each with the integrity of the artifact that was released and the version's own
`metadata.json` from #804. It gives an instance metadata for versions its image does not ship, which
#806 (fetch), #807 (`:slim` carries a snapshot) and #808 (the unavailable-version fallback's props
check) need. Published as static files on GitHub Pages under `https://flow.aiqadam.org/catalog/v1/`,
appended to by releases, never rewritten; the URL is meant to be configurable for mirroring.

**Not wired yet.** The format, the release-time writer and the API reader exist, with tests.
Nothing at run time calls the reader, no release workflow calls the writer, and nothing is published
at the default URL. Runtime behaviour is unchanged. What is left is listed below.

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
tarball (`tar -xzOf`), and checks the metadata names the same qadam and version. It refuses:
non-official names, non-canonical versions, **prerelease versions** (ADR-0004's `-main.<n>`
snapshots are never in the catalogue, and no other qadam prerelease channel exists), builds from a
dirty tree, unknown kinds, tarball names with a path, a version listed twice, and **a version already
in the catalogue with a different artifact or metadata** (a version is never republished). One
problem refuses the whole run and writes nothing; otherwise metadata files are written (`wx`) and the
index last by rename. It verifies the existing catalogue before appending. Nothing is ever removed.

## Reader (API)

`qadamVersionCatalogue.read({ source })` → `ok` (with `skippedEntries`) / `unavailable` / `invalid`
/ `unsupported`. `readMetadata({ name, version })` → `ok` / `not-in-catalogue` / `unavailable` /
`integrity-mismatch` / `invalid` (not metadata, or names another version). Bounds: index 32 MiB,
metadata 16 MiB. The HTTP source goes through `safeHttp.axios` by default (a mirror on a private
address needs `AP_SSRF_ALLOW_LIST`), at most 3 redirects, 30 s timeout, and never puts the URL in a
reason (a mirror URL may hold credentials). Both sources refuse a path that leaves their root.

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
- **`:slim` snapshot (#807).** The image copies a `catalog/v1/` tree in and the API reads it with the
  `directory` source.
- **Mirroring.** Copy the whole tree; any static server works.

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
- **The ticket's three questions** (proposals, not implemented):
  - *API reads the catalogue and the store for builder, MCP and validation of an old version
    (#411, #422).* Resolution order for `get()`: bundled → `qadam_metadata` → stored version's
    `metadata.json` (#805) → catalogue → #808's fallback. Serve catalogue-only metadata only once
    #806 can fetch that version, so the builder never offers a version the worker cannot run.
  - *`list()` "latest".* The highest version this instance can run (image or store), not the
    catalogue's highest; catalogue-only versions appear in `listVersions` once #806 can fetch them.
  - *`findBundledFallback`.* Replaced by #808, whose props check reads two catalogue entries'
    metadata.

## Domain Terms
- **Qadam version catalogue** — this feature. Say "qadam version catalogue" (code:
  `qadamVersionCatalogue`): "catalogue" alone already means the list of qadams the builder shows
  (`fetchLatestQadams`, the bundled manifest's comments).
- **Catalogue entry** — one `name@version` in `index.json`.
- **Catalogue snapshot** — a copy of `catalog/v1/` inside an image (#807).

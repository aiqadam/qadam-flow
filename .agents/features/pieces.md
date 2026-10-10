# Qadam Management

## Summary
The qadams feature manages the metadata catalog of automation integrations (called "pieces") and exposes APIs for listing, fetching, versioning, and installing custom pieces. Pieces are stored in `qadam_metadata` and served via an in-memory cache (`qadamCache`) that is rebuilt from the database on startup and refreshed via a pub/sub channel. Platform admins can install private (custom) pieces by uploading a tarball or referencing an NPM package; these are scoped to the platform with a `platformId`. The `options` endpoint runs dynamic piece property evaluation on a worker.

## Key Files
- `packages/server/api/src/app/qadams/metadata/qadam-metadata-controller.ts` — all piece routes registered under `/v1/qadams`
- `packages/server/api/src/app/qadams/metadata/qadam-metadata-service.ts` — list, get, create, delete piece metadata; manages cache interactions and piece tag enrichment
- `packages/server/api/src/app/qadams/metadata/qadam-pin-util.ts` — the canonical "does this flow-version step's pinned qadam version still resolve" predicate (#474). Wraps `qadamMetadataService.get()`/`.registry()` with a tri-state result (`true` resolved / `false` a definite miss / `undefined` the lookup errored — see the file's own comments for why the distinction matters to a caller that persists a rewrite). Used by `ap_validate_flow`, `ap_flow_structure`, `migrate-v19-strip-piece-version-wildcards.ts`, and the heal migration `migrate-v31-heal-unresolvable-qadam-pins.ts`; any new "is this pin resolvable" check should go through here rather than re-deriving it against `qadamMetadataService` directly.
- `packages/server/api/src/app/qadams/metadata/qadam-metadata-entity.ts` — `qadam_metadata` TypeORM entity
- `packages/server/api/src/app/qadams/metadata/qadam-cache.ts` — Redis/memory cache with pub/sub invalidation
- `packages/server/api/src/app/qadams/community-qadam-module.ts` — POST `/v1/qadams` for installing custom qadams (`qadamInstallService`, always persisted as `CUSTOM`). `qadamName` must match `NPM_PACKAGE_NAME_REGEX` (`QadamPackageName` in `@aiqadam/shared`: the npm package-name grammar minus `~`, which the worker's `bun install --filter` path check does not accept) for both the registry and the archive variant; the API answers anything else with 400 `invalidQadamPackageName`, and the install dialog checks the same schema before submitting. The worker holds every name to the same grammar again: `qadam-installer.ts` refuses, in `qadamPath`, a name outside it, a version that is not a single path segment, and a member directory that would not resolve strictly below `qadams/`, failing the install before anything is written; `qadam-cache.ts` answers such a name as not found before building a cache path; and the startup warmup (`qadam-warmup.ts`) sets such entries of the used-qadams list aside with a warning (name and version only) and installs the rest
- `packages/server/api/src/app/qadams/qadam-install-service.ts` — saves archive, calls engine to extract metadata, stores result. The only writer to `qadam_metadata` — nothing syncs bundled/official qadams into the DB; those are read off disk once per process by `loadBundledQadams()` (`qadams/metadata/utils/qadam-cache-utils.ts`), cached in memory, and never persisted
- `packages/server/api/src/app/qadams/metadata/utils/bundled-qadams-manifest.ts` — the bundled-qadam metadata manifest (#598), see "Bundled Qadam Metadata Manifest" below
- `packages/server/api/src/app/qadams/catalogue/` — the qadam version catalogue (ADR-0003 "Catalogue", #778): format, API reader and release-time writer for the static JSON of every released official version. Nothing calls it at run time yet; see [qadam-version-catalogue.md](./qadam-version-catalogue.md)
- `packages/server/api/src/app/qadams/tags/` — tag entity, tag service, tag-module for organizing pieces into groups
- `packages/web/src/features/qadams/api/pieces-api.ts` — frontend HTTP client
- `packages/web/src/features/qadams/hooks/pieces-hooks.ts` — React Query hooks for piece listing, piece model, piece options
- `packages/web/src/features/qadams/hooks/use-piece-output-schema.ts` — reads `outputSchema` for a given step (PIECE action or trigger) off the cached piece model; shares the existing `['piece', name, version]` React Query cache so no extra network call is made
- `packages/web/src/features/qadams/components/` — `PieceIcon`, `PieceIconList`, `PieceSelectorSearch`, `InstallPieceDialog`
- `tools/scripts/qadams/bundle/` — builds a qadam version as the ADR-0003 artifact (#804): one esbuild bundle with `@aiqadam/*` and `zod` external and declared as `peerDependencies`, `src/i18n`, and a `metadata.json` written from loading the artifact; `qadam-artifact-config.json` holds the reviewed per-qadam exceptions (node_modules for native addons and packages that read their own files, `__dirname`-started entry points). Nothing publishes this format yet; the qadam version store (#805, below) reads it, and forked engines load an official step's pin from it when it holds it (#779). Header of `qadam-artifact.mjs` documents the layout; `tools/ci/test-qadam-artifacts.sh` pins it
- `tools/scripts/qadams/snapshot/` — the versions a build gives the official qadams (ADR-0004, #851). `compute-snapshot-plan.mjs --counter <n>` writes a plan: a qadam with its own pending changeset is built from the tree as `<next>-main.<n>` (`<next>` from `tools/ci/changeset-plan.mjs`, each package's own level, never a dependent's bump); one without keeps its released number, from the tree when it is `0.x` and from the release archive when it is `>=1.0.0`. No plan or no archive does not fail a `main` build: it builds more snapshots (next patch) and warns; a `--mode release` build fails instead, and also for any `>=1.0.0` qadam that is neither in the archive nor named in `--produced` (what that release produces; nothing fills it yet), so a released version is never rebuilt from git. `build-qadam-artifacts.mjs --snapshot-plan <file> [--release-archive <dir>]` writes the version into each artifact's `package.json` and `metadata.json`, records the framework and platform version it was built against (`qadamArtifact.builtAgainst`, which the store copies into `integrity.json`), and takes archived qadams from the archive as they are. **Not applied to the image yet:** `ci.yml` computes and summarises the plan but the image still carries released numbers, and nothing archives releases (#804's remaining work), so every plan takes the no-archive fallback today. `tools/ci/test-qadam-snapshot-plan.sh` pins the plan; the builder half is in `tools/ci/test-qadam-artifacts.sh`
- `packages/server/utils/src/qadam-version-store/` — the qadam version store (ADR-0003 "Store", #805), see "Qadam Version Store" below
- `packages/server/api/src/app/qadams/version-store/qadam-version-store-seeding.ts` — seeds the store from the image at API start-up
- `packages/qadams/framework/src/lib/output-schema.ts` — `OutputSchema` / `OutputSchemaField` / `FieldFormat` plain TypeScript types (embedded into the piece metadata via `z.custom`)

## Domain Terms
- **Qadam** — a named integration (e.g. `@aiqadam/qadam-gmail`) providing actions and triggers
- **QadamType** — `OFFICIAL` or `CUSTOM` (platform-installed). Off the `OFFICIAL_QADAMS_INSTALL_ENABLED` flag (the default; it stays off — #477's npm-install model is ADR-0003's rejected Option B; the flag goes once steps resolve through the qadam version store, #806/#779 — #805 added the store and left the flag as it was), an `OFFICIAL` qadam is bundled: compiled into the image, loaded in-memory from `dist/package.json` (`loadBundledQadams`), never installed as a package, and shadows any persisted row of the same name regardless of version (`qadam-cache.ts`). With the flag on, `OFFICIAL` qadams are also installed through the same registry path a `CUSTOM` qadam already takes (`needsInstalling()` in `qadam-installer.ts`), and shadowing keys on `name@version` instead of `name` so a persisted official version can sit side by side with a differently-versioned bundled one. The flag additionally gates the install-time integrity check (`qadam-integrity.ts`, #482 item 4): every `@aiqadam/`-scoped entry in the workspace `bun.lock` must carry an npmjs publisher signature over the integrity bun enforced, verified against public keys **pinned in the image** (`NPM_SIGNING_KEYS`) rather than read from the registry being verified. A qadam that fails is rolled back and never marked `ready`, and the rollback restores the pre-install `bun.lock` so a refused attempt cannot launder its own output into the next attempt's baseline. One deliberate exception: a structurally unverifiable entry (a tarball, an alias) that was ALREADY in the lockfile before the install ran and whose name is not in the current batch is logged with a rename remedy rather than failing the install — the workspace is shared by every tenant, and failing every later install over somebody else's squatter bricks it for everyone without removing the squatter. A bad SIGNATURE is never tolerated this way. That pinning makes the flag the escape hatch for an npmjs key rotation too — turning it off returns the deployment to the bundled qadams. It is also why a `CUSTOM` qadam cannot be registered under the `@aiqadam/` scope: the check refuses an official-scope name resolved from a tarball, an alias, or anything else npmjs cannot have signed — and, independently of the flag, `qadamMetadataService.create` refuses the name outright (#503, `isOfficialQadamName` in `@aiqadam/shared`; migration `DeleteCustomQadamsUnderOfficialScope` removed the rows registered before that check existed). The reason the refusal does not wait for the flag: in the default `UNSANDBOXED` mode a `CUSTOM` qadam installs into the workspace every tenant shares (`getCustomPiecesPath` returns `getGlobalCacheCommonPath()`), and the engine loader (`qadam-loader.ts`) resolves an installed directory before the bundled `dist` — so a platform's `@aiqadam/qadam-slack` ran in place of the real one for every tenant on the worker. The loader now returns the bundled build for an alias whose `name@version` a bundled `dist/package.json` carries, whatever is installed under that alias; an installed copy at a version the image does not bundle still wins, which is the side-by-side case #477 needs.
- **PackageType** — `REGISTRY` (NPM) or `ARCHIVE` (uploaded tarball)
- **qadamCache** — an in-memory map of piece metadata keyed by name+version+platformId, rebuilt from DB
- **QadamCategory** — enum grouping pieces (AI, CORE, COMMUNICATION, etc.)
- **SuggestionType** — AGENT or ACTION; changes ordering in piece selector
- **OutputSchema** — optional, per-action / per-trigger structured description of how the step's output should be rendered. Shape: `{ fields: OutputSchemaField[] }`. Each `OutputSchemaField` carries `key`, optional `label` / `value` (path override) / `description`, an optional `format` (`email` / `url` / `date` / `datetime` / `number` / `boolean` / `image` / `html` / `currency` / `filesize` / `duration`), optional `currency` ISO code, optional `dynamicKey: true` for map-shaped values, and optional recursive `children` / `listItems` for nested objects and array-of-record shapes. Set by the piece author as the `outputSchema` of `createAction` / `createTrigger`. Consumed by the builder's `SmartOutputViewer` and the data selector — see [flows.md](./flows.md). Opt-in and non-breaking: pieces without an output schema render exactly as before.

## Entity

### `qadam_metadata` (`PieceMetadataEntity`)
| Column | Type | Notes |
|---|---|---|
| id | string | ApId |
| name | string | e.g. `@aiqadam/qadam-gmail` |
| displayName | string | |
| version | string | semver, collation-sorted |
| authors | string[] | |
| logoUrl | string | |
| description | string (nullable) | |
| platformId | string (nullable) | null = official; set = custom piece for that platform |
| actions | json | map of action definitions (each may include an optional `outputSchema` blob) |
| triggers | json | map of trigger definitions (each may include an optional `outputSchema` blob) |
| auth | json (nullable) | auth property definition |
| pieceType | string | `OFFICIAL` or `CUSTOM` |
| packageType | string | `REGISTRY` or `ARCHIVE` |
| archiveId | ApId (nullable) | FK to `file` for ARCHIVE type |
| categories | string[] (nullable) | |
| minimumSupportedRelease | string | semver |
| maximumSupportedRelease | string | semver |
| projectUsage | number | usage counter |
| i18n | json (nullable) | translation map |
| contextVersion | string (nullable) | context version the qadam reports through `getContextInfo()` (ADR-0002, #802), for the census (#803). `1` / `2` = that `ContextVersion`; `NONE` = loaded, reports no version (predates `getContextInfo`, oldest shim); `UNRECOGNISED` = loaded, reported something no shim here matches; NULL = not measured yet, or the qadam could not be loaded. The census counts **every value except `2`** as still needing the old contract. Mapping: `qadams/metadata/qadam-context-version.ts`. Written by `create` from the extracted metadata (install never writes NULL). See [framework-census.md](./framework-census.md) |
| contextVersionAttempts | number (default 0) | failed backfill loads of this row |
| contextVersionLastAttemptAt | timestamptz (nullable) | when the backfill last failed to load this row |

Unique index on `(name, version, platformId)`.

## Endpoints

| Method | Path | Security | Description |
|---|---|---|---|
| GET | `/v1/qadams` | unscoped (all principals) | List pieces with optional filtering (categories, search, suggestionType, locale) |
| GET | `/v1/qadams/categories` | public | Return all `QadamCategory` values |
| GET | `/v1/qadams/registry` | unscoped (all principals) | Registry manifest (name+version) for a given release |
| GET | `/v1/qadams/:name` | unscoped | Get full piece metadata by name (latest or pinned version) |
| GET | `/v1/qadams/:scope/:name` | unscoped | Get piece with scoped name (e.g. `@org/piece`) |
| GET | `/v1/qadams/:name/versions` | project (USER, QUERY) | List all available versions for a piece |
| GET | `/v1/qadams/:scope/:name/versions` | project (USER, QUERY) | Versions for scoped piece name |
| POST | `/v1/qadams/sync` | publicPlatform (USER) | Trigger registry re-sync |
| POST | `/v1/qadams/options` | project (USER, BODY) | Evaluate dynamic piece property options (dropdown values) |
| POST | `/v1/qadams` | platformAdminOnly (USER, SERVICE) | Install a custom piece onto the platform |

## Service Methods

### `pieceMetadataService`
- `list(params)` — returns sorted + searched `PieceMetadataModelSummary[]` from cache. `qadamListUtils.filterPieces` (`qadams/metadata/utils/index.ts`) only sorts and applies the search/category/suggestion filter — the platform's `filteredQadamNames` / `filteredQadamBehavior` columns exist on the entity but nothing reads them when listing.
- `getOrThrow({ platformId, name, version, locale? })` — returns full `PieceMetadataModel` for exact piece; prefers platform-specific over official; applies i18n translation
- `listVersions({ name, platformId, projectId })` — returns all available semver versions from registry cache
- `create({ pieceMetadata, packageType, platformId, pieceType, archiveId? })` — inserts metadata record and invalidates cache
- `registry({ release? })` — returns lightweight name+version list for all pieces

### `pieceInstallService`
- `installPiece(platformId, params)` — saves archive file if needed, dispatches `EXECUTE_METADATA` engine job to extract piece metadata from the package, then stores via `pieceMetadataService.create` (always as `CUSTOM` — there is no service that persists an `OFFICIAL` row; see `qadamCache`/`loadBundledQadams` below)

### `qadamContextVersionBackfill` (`qadams/qadam-context-version-backfill.ts`)
Fills `contextVersion` for CUSTOM rows that predate the column (#802). It is a system job
(`qadam-context-version-backfill`, hourly at :17) and not part of the migration, because a version is
only known by loading the qadam on a worker. It reads every platform's rows, as a system job may (the
precedent is `ldapReconcileService.reconcileAllPlatforms`), and loads and writes each row under its
own `platformId`. It is bounded:
- **Workers.** With no worker online it dispatches nothing. When a worker does not answer (the
  watcher's safety timeout), the run stops at that row.
- **Rows per run.** At most `MAX_ROWS_PER_RUN` (10) rows per run; the next run continues.
- **No re-measuring.** A row that loaded (`1` / `2` / `NONE` / `UNRECOGNISED`) is never loaded again.
- **Failed loads.** A failed load (including a missing archive, an official-scope name that is never
  handed to a worker, and a worker that did not answer) counts an attempt. It is retried 6 h and then
  12 h later, and after `MAX_ATTEMPTS` (3) the row stays NULL for good.

## Bundled Qadam Metadata Manifest (#598)
`loadBundledQadams()` used to `require()` every bundled qadam's `dist` on the first call
(`fileQadamsUtils.loadAllDistQadamsMetadata`). `require` never yields, so the first `GET /v1/qadams`
after a start blocked the app's event loop for 30–63 s on QA, and every request, socket and queue
consumer in the process waited behind it. The result is cached, so only the first caller paid, but
every caller of `loadBundledQadams` (the catalogue, `qadamCache.loadRegistry`, the pinned-version
fallback in `findBundledFallback`, `fetchQadamVersion`) could be that first caller.
- **Written in the image.** The Dockerfile's run stage, after `bun install --production`, runs
  `node packages/server/api/dist/src/scripts/write-bundled-qadams-manifest.js packages/qadams`. It
  runs the same scan against the exact tree and `node_modules` the app would scan, and writes
  `packages/qadams/bundled-qadams-metadata.json`: `{ version: 1, qadams: QadamMetadata[] }` in scan
  order, `directoryPath` relative to `packages/qadams`, `i18n` always included
  (`bundledQadamsManifest.writeFromScan`, one walk shared by the load and the check). It writes
  nothing and exits 1, failing the build, if the walk finds no built dist, or if any built dist it
  finds failed to load, all of them included. A partial manifest would hide that qadam for the
  image's whole life, so the writer names the skipped dists and refuses. A `test -s` follows it. The file is gitignored. Never generate it in a dev tree.
- **Read at run time.** `bundledQadamsManifest.read` does an async `readFile` and one `JSON.parse`.
  That, plus the checks below, is ~80–100 ms for the 5.8 MB file, with a ~25 ms longest event-loop
  stall, against ~2.6–3.3 s for the scan on the same box. It returns what the scan would: `directoryPath` resolved back to
  absolute, and `i18n` dropped unless `AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS` is on. Per-locale
  translation still happens after loading, in `fetchLatestQadams` / `getOrThrow`.
- **Rejected → scan**, with `[bundledQadamsManifest] manifest rejected, scanning instead {reason}`
  at warn (the reason only, never a path). The reasons:
  - `unreadable`;
  - `not a version-1 manifest`: not JSON, another format version, or an entry missing
    `name` / `version` / `displayName` / `directoryPath` / `actions` / `triggers`;
  - `no entries`;
  - `an entry points outside the qadams root`;
  - `an entry has no built dist`: its `dist/package.json` is gone;
  - `an entry does not match its built dist`: that `package.json`'s name or version differs;
  - `the qadams tree could not be listed`: the walk below threw;
  - `a built dist has no entry`: the set of entries' `directoryPath`s is not the set of `dist`
    folders on disk.

  `the qadams tree could not be listed` is a walk failure, not staleness. The other two are the
  staleness check, in both directions:
  - **A rebuilt dist.** The scan takes a qadam's name and version from its `dist/package.json`, and
    every qadam change bumps its version, so a dist rebuilt at a new version after the manifest was
    written is caught.
  - **An added dist**, for example a derived image layering in another qadam. It is caught by
    walking the tree with the scan's own walk (`fileQadamsUtils.findDistQadamFolders`, no
    `require`). The walk is concurrent and order-preserving, ~20–45 ms over the real tree, against
    ~280–420 ms for the old sequential one.

  A rebuild at the **same** version is not caught. That is why only the image writes the file, as
  the last thing built in the run stage.
  A missing manifest (the dev tree) scans quietly. `AP_DEV_QADAMS` always scans its filtered set,
  manifest or not, because those dists are rebuilt while the process lives.
- **Which path ran.** One line per process:
  `[loadBundledQadams] Bundled qadam metadata loaded {source: manifest|scan|dev-qadams-scan, qadams, durationMs}`.
- **Values computed from the clock at module load.** A few qadams compute a prop default or sample
  data from the clock when their module loads:
  - `qadam-messagebird` `listMessages` `startAt` / `endAt`;
  - `qadam-microsoft-power-bi` `push_rows_to_dataset_table` `rows` example;
  - `qadam-okta` `new_event` sample data.

  The scan froze those values at app start. The manifest freezes them at image build. They are the
  only leaves where the manifest and a fresh scan of the same tree differ; two scans in two
  processes differ in exactly the same four leaves.

## Qadam Version Store (#805)
ADR-0003's versioned store of qadam versions on a persistent volume. **Partly authoritative (#779,
first slice):** a forked engine (`UNSANDBOXED`, `SANDBOX_CODE_ONLY`) loads an official step's exact
pin from the store when the store holds it (see "Resolution" below). The API's metadata
(`qadamMetadataService.get`, the census' `resolveOfficialPin`), the worker's provisioning and its
resolution cache, isolate modes and custom qadams do not resolve through it yet, and no image seeds
it before #807, so on a real install it is still empty. "Store" alone is ambiguous here (Store
qadam, Store Entry): say "qadam version store".
- **Where.** `AP_QADAM_VERSION_STORE_PATH` (default `/var/lib/qadam-flow/qadam-versions`).
  `docker-compose.yml` mounts the named volume `qadam_versions` there on the app (read-write, it
  seeds) and read-only on every worker (#779 app-sec: a forked engine runs flow code as the worker
  user, `read` does not re-hash files, so a writable store would let one engine plant code every
  tenant runs). Nothing in the worker or engine writes the store; both use `qadamVersionStoreReader.open`.
  The worker checks it (`cache/qadams/read-only-mount.ts`): it opens the store and takes the mount the kernel
  actually reached from `mnt_id` in `/proc/self/fdinfo/<fd>` (so a writable mount stacked over the store or an
  ancestor later is the one judged), and in `/proc/self/mountinfo` that mount and every mount below it (by
  parent id) inside the store must carry `ro`; otherwise the store is not used outside
  `AP_ENVIRONMENT=dev` (warned there) and steps load the bundled builds. Not `access(W_OK)`: Linux
  (`do_faccessat`, fs/open.c) checks permission bits before it reports a read-only mount, so a non-root
  worker gets EACCES on a root-owned store whether or not the mount is `:ro`. Without a mount table only
  EROFS from `access(W_OK)` on the root, `qadams/` and `qadams/_platform/` counts. `docker-compose.sandboxed.yml` (CAP_SYS_ADMIN) with a forked mode could remount it, so do not combine them.
  Outside `/usr/src/app` on purpose: a stored version resolves packages upward from its own
  directory, and `open` refuses a root at or below any directory holding a `node_modules`. That
  covers the upward walk only; `NODE_PATH` (the sandbox env sets `/usr/src/node_modules`) and the
  global folders are refused by the engine's resolve hook (see "Resolution"). A named volume because `open` also refuses a
  case-insensitive filesystem: platform ids and prerelease versions differ by case. When the store
  cannot open, the seeding hook logs it at warn (info in `AP_ENVIRONMENT=dev`) and returns.
- **Layout** (`qadam-version-store-layout.ts`, an on-disk format later releases must read):
  `qadams/<name>/<version>/` for official qadams (`@aiqadam/qadam-*` only),
  `qadams/_platform/<platformId>/<name>/<version>/` for custom ones (never the `@aiqadam/` scope),
  `qadams/node_modules/` reserved for the libraries the platform provides (#779 left it unused: the
  engine's resolve hook provides them, see "Resolution"), `.staging/` and `.trash/` beside `qadams/`. Names are held to `NPM_PACKAGE_NAME_REGEX` minus
  a `node_modules` segment, versions to canonical semver without build metadata, platform ids to
  the `ApId` shape; a path is built only from validated coordinates and checked to stay in its
  namespace. `_platform` and dot-directories cannot collide with a package name.
- **A version directory** holds the artifact (`package.json`, its entry point, `node_modules` when
  the format has one), `metadata.json`, and `integrity.json` (store format version, coordinates,
  format/kind, entry point, `builtAgainst` — the framework (and platform) version the artifact says it was
  built against, `null` when it does not say or says something that is not a version (ADR-0004
  decision 8; surfacing it in audit records and the census is not built) — origin — `image-seed` /
  `registry` / `archive` with the tarball's sha512 — and a sha512 digest over every file's path, executable bit and content, or a symlink's target).
- **Formats** (`qadam-version-store-format.ts`). `bundle` when `package.json` carries
  `qadamArtifact: { formatVersion: 1, kind }` (#804); any other `formatVersion` or kind is refused,
  never read as legacy. `legacy-npm` when there is no marker — decided by the marker, not the version
  (`qadam-assemblyai@2.0.0` is legacy). Both: `package.json` and `metadata.json` must name the
  coordinates, `main` must be a regular file inside the version, and the version must not carry its
  own `node_modules/@aiqadam/*` (any depth) or top-level `node_modules/zod` (#772 option C: those
  resolve upward to the platform's copy). `main` resolves as Node's CommonJS loader does (file,
  `.js`, `/index.js`, then the package's `index.js`), `.js` only, inside the version. Bundles: peers
  only among `@aiqadam/shared|qadams-framework|qadams-common` and `zod`, no `node_modules` for kind
  `bundle`. `bundle-with-node-modules` must record `builtFor` os, cpu, libc and node, and runs only on
  the same os/cpu, the same Node major, and glibc at least as new (or non-glibc on both sides) — the
  same rule on write and on read.
- **Read statuses.** `PRESENT`, `ABSENT`, `DAMAGED` (the store's own files are wrong: `integrity.json`
  missing (ENOENT) or not JSON, a record or `package.json` naming other coordinates, missing entry
  point, digest mismatch), `UNSUPPORTED` (a newer `storeFormatVersion`, an enum value or artifact
  `formatVersion`/kind a later release added, a peer this release does not provide, native modules
  for another host), `UNREADABLE` (any I/O error but ENOENT), `INVALID_COORDINATES`. **Only `DAMAGED`
  is ever replaced**; on `UNSUPPORTED`/`UNREADABLE` a write returns `REFUSED` and the seed counts the
  version as `kept` — so a rollback, another host on the volume, or a transient EACCES/EIO never costs
  a version.
- **Writes** are stage → check → `integrity.json` (files fsync'd while hashed) → `chmod 0755` →
  `rename` into place; a version is never overwritten (`EXISTS`), a concurrent writer loses the rename
  and discards its copy. A damaged version is moved to `.trash/`, and what was moved is read again: if
  it reads `PRESENT` (another writer replaced the damaged one in between), it is put back and the
  write returns `EXISTS`. `putTarball` extracts with `qadam-version-store-tarball.ts`, which reads the
  tarball once through one descriptor and returns the sha512 of exactly the bytes it parsed; the
  expected integrity (sha512 only) is compared before commit. Extraction: regular files and
  directories only (an entry node-tar skips, `ignoredEntry`, refuses the archive too), one top-level
  directory stripped, no `..`/absolute/backslash/NUL/duplicate paths, `wx` creates, modes reduced to
  0644/0755, entry/byte/file-size limits and node-tar's decompression-ratio guard, one file open at a
  time. `createStaging` / `commit` are for a writer
  that assembles a version itself (#806's legacy install): symlinks are accepted only when their
  target, as written, stays inside the version and whose realpath does too; hard links (`nlink > 1`,
  e.g. bun's default hardlink backend) are refused — install with `--backend=copyfile`.
- **Reads** check `integrity.json`, the coordinates it names, `package.json` against the recorded
  format, `builtFor`, the entry point, and that the real path is the layout's (no symlinked
  component). `verify: true` re-walks and re-hashes the tree.
- **Seeding** (`qadam-version-store-seed.ts`, `qadamVersionStoreSeeding` in the API's
  `appPostBoot`, background, never throws). Report: `stored`, `present`, `kept`, `failed`. Reads `AP_QADAM_VERSION_STORE_SEED_PATH` (default
  `packages/qadams/version-store-seed`): #804's `--pack` output, `archive-index.json` + tarballs.
  No image ships one before #807, so today every start logs `status: no-seed`. Idempotent; replicas
  serialise on the `qadam-version-store-seed` `distributedLock`, and correctness does not depend on
  it. A version already stored is kept even if the image's tarball differs (warned). One line per
  start: `[qadamVersionStore] Seeded the qadam version store from the image {status, stored, present, kept, failed, durationMs}`.
- **Resolution (#779, first slice).** Read-only outside the app. The worker opens the store at
  `AP_QADAM_VERSION_STORE_PATH` (`WorkerSystemProp.QADAM_VERSION_STORE_PATH`, same default as the
  API) with `qadamVersionStoreReader.open` (`qadam-version-store-read.ts`: realpath + the
  `node_modules`-above check, no mkdir, probe or cleanup) before it creates its first sandbox, and
  in every execution mode, so a later switch to a forked mode on reconnect has a root
  (`cache/qadams/qadam-version-store-root.ts`; unusable-store lines are info in dev, warn otherwise). Sandbox env
  always carries `AP_QADAM_VERSION_STORE_PATH`: the real root for forked engines, `''` otherwise, so a
  value an operator propagates (`AP_SANDBOX_PROPAGATED_ENV_VARS`) never reaches an isolate engine
  (mounting the store there is a later slice: only the official tree and the job's own platform
  namespace, and isolate mounts must sit under `/root`, which holds a `node_modules`). The engine
  opens it the same way through `@aiqadam/server-utils/qadam-version-store-reader`
  (`qadam-version-store/reader.ts`, reader + layout + `PLATFORM_PROVIDED_PACKAGES`, no writer, no
  `tar`), taken from source by an esbuild/vitest alias and a `tsconfig.base.json` path. That subpath
  does not exist at run time anywhere else, and `serverConfigs.server` (`tools/eslint/server.mjs`)
  forbids `@aiqadam/server-utils/*` outside the engine. `qadam-loader.ts` resolves dev qadam →
  **store** (`qadam-version-store-resolver.ts`, official namespace, exact `x.y.z` or `x.y.z-main.<n>` pins) → bundled
  build at the same version → installed copy → `qadamPinFallback` (`qadam-pin-fallback.ts`, the
  run-time net under #808's audited move, see [qadam-pin-moves.md](./qadam-pin-moves.md)): a release
  pin runs on the image's build by name only when that build is a release inside
  the pin's caret range, with one `console.warn` per pin and process; a snapshot pin never does;
  everything else fails `QadamNotFoundError` naming the pin. The caret rule is
  `qadamPinFallbackDecision.checkNet`, shared with the API (`@aiqadam/server-utils/qadam-pin-fallback-decision`,
  one more engine-only alias). Deleting the module fails every unavailable pin. A fallback answer is not memoised in `qadamPathCache`,
  so a version fetched into the store later is seen by the next load. A stored version that is not
  PRESENT/ABSENT is skipped with one `console.warn` per version and process. The cold-load line
  carries `source` (`store` / `bundled` / `bundled-fallback` / `installed` / `dev`). The worker
  provisions agent-tool qadams (a PIECE step's `agentTools` array, read by `agentToolPins` in
  `@aiqadam/server-utils`, which the API's `qadamPinUtil.getAgentToolPins` uses too, so
  `ap_validate_flow` and `ap_flow_structure` report tool pins; `extractQadamPackages`) through
  the same `qadamCache.getPiece` check as steps (a version that is no pin is `PieceNotFoundError`,
  carrying `usedBy` for the error text), and `needsInstalling` never installs a snapshot
  from a registry. The API resolves an exact pin by equality, and gives a snapshot pin no bundled
  stand-in (`findExactVersion`).
  **Platform-provided libraries** (`qadam-platform-modules.ts`): before the first stored version
  loads, the engine registers a `module.registerHooks` resolve hook for modules under the store's
  `qadams/` (both namespaces). Builtins are Node's. A `PLATFORM_PROVIDED_PACKAGES` specifier (or a
  subpath) gets the platform's copy: `qadams-framework` and `qadams-common` are the workspace
  packages `packages/qadams/{framework,common}`, `@aiqadam/shared` and `zod` are the framework's own
  runtime dependencies, resolved from `packages/qadams/framework` (the same real paths bundled
  qadams reach, so one copy per engine). A subpath with an empty, `.` or `..` segment is refused, and
  the resolved file must lie inside that package's real directory. The qadam's own code always gets
  the platform's copy (a `src/node_modules/zod` beside it is ignored); a third-party module under the
  version's `node_modules/` gets a private copy nested under it first (#829). Any other specifier
  must resolve inside the module's own version directory, else `MODULE_NOT_FOUND` (no `NODE_PATH`,
  global folders or the reserved `qadams/node_modules`). This is a correctness guard against
  accidental lookups, not a sandbox: a stored version runs with the engine's rights. Hooks do not
  reach worker threads or child processes a qadam starts (csv's worker, oracle-database's runner).
- **Left to other tickets:** the rest of #779 (the API reading a stored version's `metadata.json` and the
  framework census doing the same, isolate mounts, custom qadams, removing `qadamPinFallback` once #808's move covers every path), fetching
  and the legacy install path (#806), persisted signature verification next to the store (#780), GC
  and registry config (#478), image seed contents (#807), the rest of the unavailable-version fallback (#808: the marking, the start-up and import passes, the catalogue read).

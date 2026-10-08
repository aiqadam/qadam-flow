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
- `packages/server/api/src/app/qadams/tags/` — tag entity, tag service, tag-module for organizing pieces into groups
- `packages/web/src/features/qadams/api/pieces-api.ts` — frontend HTTP client
- `packages/web/src/features/qadams/hooks/pieces-hooks.ts` — React Query hooks for piece listing, piece model, piece options
- `packages/web/src/features/qadams/hooks/use-piece-output-schema.ts` — reads `outputSchema` for a given step (PIECE action or trigger) off the cached piece model; shares the existing `['piece', name, version]` React Query cache so no extra network call is made
- `packages/web/src/features/qadams/components/` — `PieceIcon`, `PieceIconList`, `PieceSelectorSearch`, `InstallPieceDialog`
- `packages/qadams/framework/src/lib/output-schema.ts` — `OutputSchema` / `OutputSchemaField` / `FieldFormat` plain TypeScript types (embedded into the piece metadata via `z.custom`)

## Domain Terms
- **Qadam** — a named integration (e.g. `@aiqadam/qadam-gmail`) providing actions and triggers
- **QadamType** — `OFFICIAL` or `CUSTOM` (platform-installed). Off the `OFFICIAL_QADAMS_INSTALL_ENABLED` flag (the default; it stays off — #477's npm-install model is ADR-0003's rejected Option B, and #805/#806 remove the flag), an `OFFICIAL` qadam is bundled: compiled into the image, loaded in-memory from `dist/package.json` (`loadBundledQadams`), never installed as a package, and shadows any persisted row of the same name regardless of version (`qadam-cache.ts`). With the flag on, `OFFICIAL` qadams are also installed through the same registry path a `CUSTOM` qadam already takes (`needsInstalling()` in `qadam-installer.ts`), and shadowing keys on `name@version` instead of `name` so a persisted official version can sit side by side with a differently-versioned bundled one. The flag additionally gates the install-time integrity check (`qadam-integrity.ts`, #482 item 4): every `@aiqadam/`-scoped entry in the workspace `bun.lock` must carry an npmjs publisher signature over the integrity bun enforced, verified against public keys **pinned in the image** (`NPM_SIGNING_KEYS`) rather than read from the registry being verified. A qadam that fails is rolled back and never marked `ready`, and the rollback restores the pre-install `bun.lock` so a refused attempt cannot launder its own output into the next attempt's baseline. One deliberate exception: a structurally unverifiable entry (a tarball, an alias) that was ALREADY in the lockfile before the install ran and whose name is not in the current batch is logged with a rename remedy rather than failing the install — the workspace is shared by every tenant, and failing every later install over somebody else's squatter bricks it for everyone without removing the squatter. A bad SIGNATURE is never tolerated this way. That pinning makes the flag the escape hatch for an npmjs key rotation too — turning it off returns the deployment to the bundled qadams. It is also why a `CUSTOM` qadam cannot be registered under the `@aiqadam/` scope: the check refuses an official-scope name resolved from a tarball, an alias, or anything else npmjs cannot have signed — and, independently of the flag, `qadamMetadataService.create` refuses the name outright (#503, `isOfficialQadamName` in `@aiqadam/shared`; migration `DeleteCustomQadamsUnderOfficialScope` removed the rows registered before that check existed). The reason the refusal does not wait for the flag: in the default `UNSANDBOXED` mode a `CUSTOM` qadam installs into the workspace every tenant shares (`getCustomPiecesPath` returns `getGlobalCacheCommonPath()`), and the engine loader (`qadam-loader.ts`) resolves an installed directory before the bundled `dist` — so a platform's `@aiqadam/qadam-slack` ran in place of the real one for every tenant on the worker. The loader now returns the bundled build for an alias whose `name@version` a bundled `dist/package.json` carries, whatever is installed under that alias; an installed copy at a version the image does not bundle still wins, which is the side-by-side case #477 needs.
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

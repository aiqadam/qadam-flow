---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#433"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0001. Official qadams run from a versioned local store, on libraries the platform provides

## Decision

The platform is the operating system; qadams are programs; flows are instructions that pin a
program version. A step pinned to `tables@0.3.1` resolves to and executes `tables@0.3.1`'s own
code from a **versioned store on a persistent volume**, while `@aiqadam/qadams-framework`,
`@aiqadam/qadams-common` and `zod` are **provided once by the platform** and never carried per
qadam version.

- **Artifact.** A qadam version is one bundle — its own code and third-party dependencies, with
  `@aiqadam/*` and `zod` left to the platform as peers — plus `metadata.json`. The same file goes
  into images and to npm. Qadams with native modules ship as a directory with `node_modules`.
- **Images.** `:fat` seeds the store with every official qadam at its current version; `:slim`
  with the platform and the 27 core qadams. `run.sh` installs `:slim`. `:latest` stays an alias of
  `:fat`, so existing installs keep what they have, and is retired later through
  `docs/install/configuration/breaking-changes.mdx`.
- **Fetching.** A version missing from the store is fetched from npmjs, or a registry configured
  by URL and token, into the store — when a flow is published or imported, and in the background at
  start-up for every pinned version that is missing. `@aiqadam/*` packages without a valid npm
  signature are not installed; for custom qadams the check is a platform setting, off by default.
- **Catalogue.** Metadata for **every** version of every official qadam, with tarball integrity, is
  published as static JSON on GitHub Pages under `flow.aiqadam.org/catalog/v1/`. Releases append to
  it; slim images carry a snapshot; the URL is configurable for mirroring.
- **Unavailable version.** If a pinned version cannot be fetched, the step moves to the image's
  version only when that version is inside the pin's caret range (ADR-0003) and the catalogue shows
  its props are compatible, with an audit record. Otherwise
  the step is marked "version unavailable — update this step" in the builder, MCP and runs, and the
  flow is never disabled (#435).
- **The SDK.** The 104 symbols qadams import from `@aiqadam/shared` move into
  `@aiqadam/qadams-framework`, which re-exports them; qadams may no longer import `shared`.
  `qadams-framework@1.0.0` is cut when that move, the import ban and the API-diff gate are in
  place; from then on the support policy in ADR-0002 applies. `shared` itself stops being
  published (ADR-0003). What each version number means, and how it is raised, is ADR-0003.

This answers #785: a pin covers the qadam's own code and its third-party dependencies; the
framework chain is the platform's, kept compatible by API discipline.

## Context

**The failure.** A step stores an exact version (`packages/web/src/features/qadams/utils/qadam-selector-utils.ts:242`,
`packages/server/api/src/app/mcp/tools/ap-add-step.ts:121` at `2b1f313a`), but an image holds exactly
one build of each official qadam (`loadBundledQadams` → `loadFromDisk`,
`packages/server/api/src/app/qadams/metadata/utils/qadam-cache-utils.ts:42-71` at `2b1f313a`). Every
image upgrade that moves a qadam's version strands the steps pinned to the old one: #411, #422,
#432 (`tg-router` disabling itself on `pro-data-tech-qa`). The workarounds so far are symptom-level:
five hand-written pin migrations for `@aiqadam/qadam-ai` (`migrate-v24` … `migrate-v30`, whose own
comment says "the next republish after this one needs its own file too"), a caret-clamped bundled
fallback (#424, `qadam-metadata-service.ts:304` at `94dc9ae3`) that cannot cross a `0.x` minor, and
a one-off heal (#474 / #487). #435 already stopped a missing pin from disabling a published flow.

**How we got here.** The fork inherited upstream's model — exact pins, plus a catalogue of every
version synced from a cloud registry and code fetched per version — but not its second half: the
qadams were rebranded and never published, the sync pointed at a host that served no catalogue,
and #136 (`33bdab20`) removed it as dead code. Exact pins stayed; the store of versions did not.

**What #433 decided first, and why this ADR changes the mechanism.** #433's decision comment chose
"official qadams become published packages installed from a registry", implemented as #475 / #476 /
#477 / #478. Steps 0, 1a and 1b are done; #477 sits behind `OFFICIAL_QADAMS_INSTALL_ENABLED`
(default `'false'`, `packages/server/api/src/app/helper/system/system.ts:71` at `94dc9ae3`). Scoping
the flip found that published qadams pin their own exact `shared` / `framework` / `common` (today
`tables@0.5.1` depends on `shared@0.155.0`, `common@0.17.0`, `framework@0.35.0`), so each installed
version brings its own copies (#772: 155 of 238 qadams carry three copies of `shared`), that no
metadata exists for older official versions (#778), and that installs need network at run time
(#780). `shared` itself moved through 13 published versions (0.135.0 → 0.155.0) in about three
weeks — it is not a contract qadams can depend on. The goal of #433 stands; this ADR replaces how
it is delivered.

**Deployment constraints** (recorded on #433, 2026-10-08): instances run in our cloud and at
customers' sites with internet or a corporate npm proxy (Nexus / Artifactory); fully air-gapped
sites with no proxy are not a target. Who upgrades on-prem, and how often, varies. External
authors will write qadams against the SDK.

## Options considered

### Option A — versioned local store, platform-provided libraries, slim/fat images (chosen)

Measured on a prototype (see Evidence): a qadam's own code is small (median 73 KB, the whole
catalogue 3.8 MB gzipped), so keeping every version is cheap; with one copy of the libraries in
the engine, an extra loaded version costs ~2 MiB and ~10 ms instead of ~41 MiB per extra `shared`
copy; old versions load and run unchanged on the current framework. Exact pins stay honest, and
everything already in the store works without network.

### Option B — install every version from npm as published (#433's first mechanism, #477 as specified)

Rejected. Each version installs with its own exact `shared` / `framework` / `common` (#772), ~41 MiB
of heap per extra `shared` copy; QA's twelve most-used qadams would pull six. It needs metadata for
versions the instance never bundled (#778) and network or a pre-seeded cache on every cold start
(#780), and freezes library bugs into every published version. Upstream runs this model and had to
retire its S3 mirror for pinning bugs (upstream ADR 0028) and bump all community pieces to ship one
`pieces-common` fix (activepieces#14558).

### Option C — one version per image, automatic pin migration to it

Rejected as the model; kept as the fallback for an unfetchable version. Cheapest and fully offline,
and the prototype shows it would have been safe at the props level for every core qadam that changed
since June. But it changes the code under a published flow — props-compatible is not
behaviour-compatible (#397 changed `telegram-bot` behaviour with an identical schema) — and
upstream, which does this through `piece-upgrade-register.json` + `migrate-v23`, moved working
Oracle steps onto a target that failed every run.

### Option D — behaviour versions inside one qadam package (n8n's `typeVersion`)

Rejected as the platform model; open to individual qadams. It keeps old behaviour without storing
old builds, but only where authors maintain every branch, and does nothing for a pin to a build that
no longer exists.

### Option E — self-contained bundles that include the libraries (upstream since activepieces#13822)

Rejected. A pinned version is byte-identical forever, but every bundle carries its own libraries, so
memory scales with the number of distinct versions loaded and a library fix reaches no published
version.

### Sub-decisions inside Option A

| Question | Chosen | Rejected, and why |
| --- | --- | --- |
| Artifact format | One bundle, same file in images and npm | npm package + `bun install` per version: needs network and dependency resolution at install, two sources that can drift (upstream ADR 0028), and permanent overrides of exact `@aiqadam/*` pins |
| What the platform provides | `@aiqadam/*` + `zod` | `@aiqadam/*` only: qadams build prop schemas with `zod` and the framework validates them, so two `zod` copies would meet at that boundary |
| Where qadam-facing `shared` symbols go | Re-exported from `qadams-framework` | A new `@aiqadam/qadams-sdk`: a second package to keep stable and version in step, for symbols that are mostly enums and helpers (`QadamCategory` in 196 qadams, `isNil` 126, `MarkdownVariant` 61) |
| Catalogue scope | Every version | Current versions only: no schema to decide the fallback, to render an old step in the builder (#422), or to import a flow from another instance; history costs ~2 MB/year |
| When to fetch | Publish / import, and at start-up | Publish / import only: after a lost volume or a switch to `:slim`, already published flows would point at missing versions |
| Signature check | Mandatory for `@aiqadam/*`; setting for custom | Mandatory for everything: customers' private registries may not carry npm signatures |
| Default image | `run.sh` → `:slim`; `:latest` = `:fat` | `:latest` = `:slim`: a plain `docker compose pull` would silently turn existing installs into slim ones that need a registry; dropping `:latest` breaks every existing install |
| GC | Image-shipped versions never; others after 10 days unreferenced | One rule for all: the image would re-seed what GC just removed |
| Already published 238 versions | Republish in the new format — as `1.0.0` (ADR-0003) — only when each qadam next changes; older versions installed from npm with `@aiqadam/*` overridden | Mass republish: a release of every qadam with no code change |
| Registry at install | `QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN` passed to `run.sh`, reachability checked, `:fat` suggested on failure | Configure later only: a slim install behind a proxy would look healthy and fail on first use; reading the host's `~/.npmrc`: host and container config differ and tokens would move silently |
| `qadams-framework@1.0.0` | When the SDK move, import ban and API-diff gate are in place | Now: the first `shared` move would force 2.0 at once; at the first external author: too late for a contract |

## Consequences

**Easier.** A published flow keeps executing the code it was built with across platform upgrades,
offline, for every version in the store. One copy of the libraries per engine. The "one migration
file per republish" pattern ends.

**New obligations.**
- `qadams-framework` and `qadams-common` are a public API from 1.0.0: an API-diff gate in CI;
  breaking changes only in a major; the support window and its CI gate are ADR-0002.
- A lint rule forbids qadams from importing `@aiqadam/shared`.
- New publishes declare `@aiqadam/*` and `zod` as `peerDependencies` (#772 option B); older versions
  installed from npm get them overridden (#772 option C). The loader reads both formats.
- Release artifacts are archived when built and never rebuilt from git: the prototype could not
  rebuild `csv@0.4.14` from its own commit because its `xlsx` dependency is no longer in the tree,
  and #476 found no per-version tags.
- The release pipeline appends each new version's metadata to the catalogue.
- A qadam that changes props is checked against its previous version in CI; that check also
  decides when the unavailable-version fallback may move a step.

**Store.** `<volume>/qadams/<name>/<version>/` (artifact + `metadata.json` + integrity) on a
persistent volume, seeded by the image at start-up; custom qadams live in the same store under a
per-platform namespace.

**Harder / risks.**
- Old qadam code runs on new libraries: a behaviour change in `framework` / `common` changes old
  qadams too. Mitigated by the API gate and ADR-0002.
- Bundling has edge cases (`import.meta`, native modules: `crypto` failed to load, `sftp`, `duckdb`
  and `metabase` did not bundle in the prototype).
- Two image flavours to build, test and document; slim instances depend on the registry and the
  catalogue host for anything not yet in their store.
- Until each qadam is republished, two artifact formats coexist in the store.

**Irreversible.** Versions published to npm stay there. The store layout becomes an on-disk format
later releases must read.

## Evidence

Prototype on `origin/main` @ `94dc9ae3`, Node v24.21.0, a local dev container, warm disk; not
measured on QA. Old versions were rebuilt from their own commits with today's third-party
dependencies, so they approximate, not reproduce, the original artifacts. `@aiqadam/*` were left
external to each bundle and resolved to one built copy.

| Measurement | Result |
| --- | --- |
| `tables` own code / + third-party deps / everything incl. `shared` | 69 KB (14 KB gz) / 628 KB / 1.2 MB |
| Whole catalogue, own code (235 of 238 bundled) | 20 MB raw, 3.8 MB gz, median 73 KB, max 462 KB |
| Whole catalogue, own code + third-party deps | 337 MB raw, 30 MB gz |
| Version churn, 2026-06-20 → 2026-10-08 | ~240 version bumps across all qadams (`tables`: 9) |
| Catalogue metadata, current versions (227 of 235 loaded) | 5.4 MB raw, 0.58 MB gz, median 11 KB |
| Platform libraries, one copy (`shared` + `framework` + `common`) | +52.7 MiB heap, ~140 ms |
| Each extra loaded `tables` version (0.3.1, 0.4.5, 0.5.1) | +1.6–2.2 MiB heap, ~10 ms |
| Each extra copy of `shared` (Option B's cost) | +41 MiB heap, 60–100 ms |
| `tables@0.3.1` and `@0.4.5` on the current framework | load, expose metadata, `contextVersion=2` |
| `csv@0.4.14`, `@0.5.0`, `@0.6.0` running `convert_csv_to_json` in one process | identical output |
| Props ABI, June version → current, every core qadam that changed | 12 of 12 compatible (only additions) |
| Old `tables` source type-checked against today's `shared` | 2–3 errors (`FieldType`, `Filter` unions widened) |
| `shared` symbols imported by qadams | 104 distinct; 206 qadams import `shared`, 238 `framework`, 200 `common` |

Prior art, upstream Activepieces @ `4d7a96ac`: exact pins frozen per locked flow version (their ADR
0005); pieces fetched as links to npm / CDN tarballs (ADR 0006); the S3 mirror removed because "a
cache that can outrank its own upstream is a cache that pins a bug" (ADR 0028); forced pin upgrades
despite "Flows never auto-upgrade" in their docs (`piece-upgrade-register.json`, `migrate-v23`, plus
per-version fixes `migrate-v24`, `-v25`, `-v27`).

## Follow-ups

- SDK: move the qadam-facing `shared` symbols into `qadams-framework`; lint ban; API-diff gate; cut
  `qadams-framework@1.0.0`.
- Artifact: bundle build per qadam (`@aiqadam/*` and `zod` external), native-module exception,
  archive at release, publish as `peerDependencies`; override path for already published versions.
- Store: layout on a persistent volume, seeding from the image, per-platform namespace for custom
  qadams, GC (image-shipped exempt, others after 10 days unreferenced — #478).
- Resolution in API and worker by `name@version`; engine provides `@aiqadam/*` and `zod` (replaces
  #779's installed-vs-loaded split).
- Fetch at publish / import and at start-up; registry URL and token; signature check (#482).
- Catalogue of all versions on GitHub Pages with integrity, appended by releases; snapshot in slim
  (replaces the metadata half of #778).
- Images `:fat` and `:slim`, `:latest` = `:fat` with a deprecation entry; `run.sh` installs `:slim`
  and takes `QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN` (fat absorbs #780's seed cache).
- Unavailable-version fallback with a props-compatibility check and audit; "update this step" UX.
- Re-scope or close #477 and #478 against this ADR once accepted; answer #785 with a link.

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
code — from a **versioned store on a persistent volume** on the instance — while
`@aiqadam/qadams-framework`, `@aiqadam/qadams-common` and the qadam-facing part of
`@aiqadam/shared` are **provided once by the platform** under a stable API, never carried per
qadam version. Images ship in two flavours that differ only in how the store is pre-filled: **fat**
(every official qadam at its current version) and **slim** (the platform plus the 27 core qadams).
A version missing from the store is fetched from a configurable npm registry into the same store,
when a flow is published or imported. A version that cannot be fetched is moved to the bundled
version automatically only when its props are ABI-compatible, with an audit record; otherwise the
step is shown as unavailable with an explicit "update this step" action.

This answers #785: a pin covers the qadam's own code and its third-party dependencies; the
framework chain is the platform's, and is kept compatible by API discipline (see Consequences).

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
version synced from a cloud registry and code fetched per version — but not its second half:
the qadams were rebranded and never published, the sync pointed at a host that served no catalogue,
and #136 (`33bdab20`) removed it as dead code. Exact pins stayed; the store of versions did not.

**What #433 decided first, and why this ADR changes the mechanism.** #433's decision comment chose
"official qadams become published packages installed from a registry" (option 1), implemented as
#475 / #476 / #477 / #478. Steps 0, 1a and 1b are done; #477 sits behind
`OFFICIAL_QADAMS_INSTALL_ENABLED` (default `'false'`, `packages/server/api/src/app/helper/system/system.ts:71`
at `94dc9ae3`). Scoping the flip found that published qadams pin their own exact
`shared`/`framework`/`common` versions, so each installed version brings its own copies (#772:
155 of 238 qadams carry three copies of `shared` in their closure), that no metadata exists for
older official versions (#778), and that installs require network at run time (#780). The goal of
#433 stands; this ADR keeps it and replaces how it is delivered.

**Deployment constraints** (recorded on #433, 2026-10-08): instances run in our cloud and at
customers' sites with internet or a corporate npm proxy (Nexus / Artifactory); fully air-gapped
sites with no proxy are not a target. Who upgrades on-prem, and how often, varies. External
authors will write qadams against our SDK.

## Options considered

### Option A — versioned local store, platform-provided libraries, slim/fat images (chosen)

Measured on a prototype (see Evidence): a qadam's own code is small (median 73 KB, the whole
catalogue 3.8 MB gzipped), so keeping every version is cheap; with one copy of the libraries in
the engine, an extra loaded version costs ~2 MiB and ~10 ms instead of ~41 MiB per extra `shared`
copy; old versions load and run unchanged on the current framework. It keeps exact pins honest,
works without network for everything already in the store, and leaves npm as a way to fill gaps
rather than a run-time dependency of every execution.

### Option B — install every version from npm as published (#433's first mechanism, #477 as specified)

Rejected. Each version installs with its own exact `shared`/`framework`/`common` (#772), ~41 MiB
of heap per extra `shared` copy; QA's twelve most-used qadams would pull six. It needs metadata for
versions the instance never bundled (#778), and network or a pre-seeded cache on every cold start
(#780). It also freezes library bugs into every published version. Upstream runs this model and
had to retire its own S3 mirror for pinning bugs (upstream ADR 0028) and bump all community pieces
to ship one `pieces-common` fix (activepieces#14558).

### Option C — one version per image, automatic pin migration to it

Rejected as the model; kept as the fallback for an unfetchable version. Cheapest and fully
offline, and the prototype shows it would have been safe for every core qadam that changed since
June at the props level. But it silently changes the code under a published flow — props-compatible
is not behaviour-compatible (#397 changed `telegram-bot` behaviour with an identical schema) — and
upstream, which does this through `piece-upgrade-register.json` + `migrate-v23`, moved working
Oracle steps onto a target that failed every run.

### Option D — behaviour versions inside one qadam package (n8n's `typeVersion`)

Rejected as the platform model; open to individual qadams. It keeps old behaviour without storing
old builds, but only for qadams whose authors maintain every branch, and does nothing for a pin to
a build that no longer exists.

### Option E — self-contained bundles per version (upstream since activepieces#13822)

Rejected. A pinned version is byte-identical forever, but each bundle carries its own libraries, so
memory scales with the number of distinct versions loaded — the cost Option A removes — and a
library fix reaches no published version.

## Consequences

**Easier.** A published flow keeps executing the code it was built with across platform upgrades,
offline, for every version already in the store. One copy of the libraries per engine. The
"one migration file per republish" pattern ends.

**New obligations.**
- `@aiqadam/qadams-framework` and `@aiqadam/qadams-common` become a **stable public API**: breaking
  changes only in a major version, enforced by a CI API-diff gate. The engine ↔ qadam `context`
  contract follows ADR-0002.
- Qadams stop importing `@aiqadam/shared`. The 104 symbols they use (top: `QadamCategory` in 196
  qadams, `isNil` 126, `MarkdownVariant` 61) move into the SDK; a lint rule forbids the import.
- New qadam publishes declare `@aiqadam/*` as `peerDependencies` (#772 option B). Already published
  versions are installed with their `@aiqadam/*` dependencies overridden by the platform's (#772
  option C) until republished.
- Release artifacts are **archived when built** and never rebuilt from git: the prototype could not
  rebuild `csv@0.4.14` from its own commit because its `xlsx` dependency is no longer in the tree,
  and #476 found no per-version tags.
- A qadam that changes props ships with a props-ABI check against its previous version in CI, which
  also decides when Option C's fallback is allowed.

**What the instance does.**
- **Store:** `<volume>/qadams/<name>/<version>/` (code + `metadata.json` + integrity), on a persistent
  volume. An image seeds it at start-up and never deletes from it. Custom qadams live in the same
  store under a per-platform namespace.
- **Resolution:** API and worker resolve `name@version` from the store; the engine provides
  `@aiqadam/*` to every loaded qadam.
- **Fetch:** a missing version is fetched at flow publish / import, from npmjs by default or a
  configured registry URL and token, into the store. A package without a valid npm signature is
  not installed.
- **Catalogue:** metadata for all current official qadams is published as static JSON on GitHub
  Pages under `flow.aiqadam.org/catalog/v1/`, with each version's tarball integrity; slim images
  carry a snapshot of it; the URL is configurable for mirroring.
- **GC:** a version referenced by any flow version is never removed; an unreferenced one is removed
  after 10 days.
- **Unavailable version:** auto-move to the bundled version only if props-compatible, with an audit
  record; otherwise the step is marked "version unavailable — update this step" in the builder,
  MCP and runs, and never disables a flow (#435).

**Harder / risks.**
- Old qadam code runs on new libraries: a behaviour change in `framework`/`common` changes old
  qadams too. Mitigated by the API gate and by keying behaviour changes on ADR-0002's context version.
- Qadams with native dependencies (`sftp`, `duckdb`, `metabase` did not bundle in the prototype) need
  a `node_modules` layout in the store rather than a single bundle.
- Two image flavours to build, test and document.
- Slim instances depend on the registry and the catalogue host for anything not yet in their store.

**Irreversible.** Versions published to npm stay there. The store layout becomes an on-disk format
that later releases must read.

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
| Props ABI, June version → current, every core qadam that changed | 12 of 12 compatible (only additions); `crypto` failed to load, `sftp` failed to bundle |
| Old `tables` source type-checked against today's `shared` | 2–3 errors (`FieldType`, `Filter` unions widened) |

Prior art, upstream Activepieces @ `4d7a96ac`: exact pins frozen per locked flow version (their
ADR 0005); pieces fetched as links to npm/CDN tarballs (ADR 0006); the S3 mirror removed because
"a cache that can outrank its own upstream is a cache that pins a bug" (ADR 0028); forced pin
upgrades despite "Flows never auto-upgrade" in their docs (`piece-upgrade-register.json`,
`migrate-v23`, plus per-version fixes `migrate-v24`, `-v25`, `-v27`).

## Follow-ups

- Stable SDK: API-diff gate for `framework`/`common`; move the qadam-facing `shared` symbols; lint
  ban on importing `shared` from qadams.
- Store: layout, persistent volume, seeding from the image, per-platform namespace for custom qadams.
- Resolution in API and worker by `name@version`; engine provides `@aiqadam/*` (replaces #779's
  installed-vs-loaded split).
- Publishing: `peerDependencies` for `@aiqadam/*` (#772 B); overrides for already published
  versions (#772 C); archive artifacts at release.
- Fetch at publish / import; configurable registry URL and token; mandatory signature check (#482).
- Catalogue on GitHub Pages with integrity; snapshot in slim (supersedes the metadata half of #778).
- Slim and fat image targets (fat absorbs #780's seed cache).
- GC after 10 days unreferenced (#478).
- Fallback and UX for an unavailable version; props-ABI check in CI.
- Native-dependency qadams in the store.
- Re-scope or close #477 and #478 against this ADR once it is accepted; answer #785 with a link.

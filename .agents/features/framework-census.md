# Framework Census

## Summary
The framework-major census of [ADR-0002](../../adr/0002-two-framework-majors-supported-for-at-least-12-months.md) (#803): each instance answers from its own database which steps are pinned to qadam versions built against a framework context version this release no longer runs, so a shim retirement is a visible, repairable list instead of a run-time surprise. It never blocks a start-up and never disables a flow (#435). Everything is resolved offline: bundled qadams from the image, custom qadams from `qadam_metadata.contextVersion` (#802).

## Key Files
- `packages/qadams/framework/src/lib/context/framework-support-table.json` — the ADR-0002 support table (#801); one row per framework major. The last row's major is the framework this tree builds.
- `packages/qadams/framework/src/lib/context/framework-support.ts` — typed access to the table, `ENGINE_CONTEXT_VERSIONS` (the context versions the dispatcher in `versioning.ts` still handles) and `PREDATES_CONTEXT_INFO` (`'none'`).
- `packages/server/api/src/app/qadams/census/framework-census-policy.ts` — the ADR-0002 rules in one place: what this release runs, what an official qadam's framework major means, what an unknown context version counts as, and which context versions are retired. Every reader goes through `engineContextVersions()`, so a test can stand in for a release that retired a shim.
- `packages/server/api/src/app/qadams/census/framework-census-service.ts` — the query: stored flow versions → pinned `name@version` → context version → status (`current` / `legacy` / `unsupported`). Read-only raw rows, so the `doctor` can run from a new image against a database that has not been migrated yet.
- `packages/server/api/src/app/qadams/census/framework-census-marking.ts` — the per-request half: `unsupportedPins()` for the MCP surfaces, `logRetirement()` for the boot log line. It skips all resolution while no shim has been retired.
- `packages/server/api/src/app/qadams/census/framework-census-controller.ts` / `framework-census-module.ts` — `GET /v1/framework-census`, platform admin only, scoped to the caller's platform.
- `packages/server/api/src/scripts/framework-census-doctor.ts` — the `doctor` command (`npm run doctor`): run from the new image before switching containers, it lists the steps the release will stop running.
- `packages/server/api/src/app/qadams/qadam-context-version-backfill.ts` — fills `qadam_metadata.contextVersion` for rows that predate it (#802).
- `packages/server/api/src/app/mcp/tools/ap-flow-structure.ts` / `ap-validate-flow.ts` — the MCP marking: a step whose pin needs a retired context version carries `frameworkVersionSupported: false` / the `framework_version` issue category.
- `packages/web/src/app/routes/platform/infra/health/components/framework-census-banner.tsx` — the operator banner on the platform health page.

## Domain Terms
- **Framework major** — a major of `@aiqadam/qadams-framework`; since 1.0.0 a new engine ↔ qadam `context` version is a new major (ADR-0002).
- **Context version** — what a qadam reports through `getContextInfo()`: `'1'` / `'2'` (a `ContextVersion`), `'none'` (it predates `getContextInfo`), or unknown.
- **Support table** — `framework-support-table.json`: per major, its context versions and release dates. A major is supported while it is the current or the previous one and for at least 12 months after its successor.
- **Retired context version** — a context version the support table lists that `ENGINE_CONTEXT_VERSIONS` no longer contains; a step needing one stops running on this release.
- **Legacy** — runs through a context shim today (context V1 or `none`), so it stops running when that shim is retired.
- **Unsupported** — this release no longer runs the step's context version. An unknown context version counts as still needing the old contract, so it is `legacy` before the first retirement and `unsupported` after it.

## Resolution
A step is counted once per meaningful version of its flow: the published version (what runs) and the latest version (what the builder edits and test runs use), deduped when they are the same. Each distinct pin is resolved once:
- **Official** (`@aiqadam/...`, or a name the image bundles): the version `qadamMetadataService.get` resolves the pin to; a bundled build's framework major comes from its own `dist/package.json` (`workspace:*` = this tree's major), a persisted row's from `qadam_metadata.contextVersion`. Before `qadams-framework@1.0.0` every official qadam reports context V2.
- **Custom**: the version the pin resolves to, then that row's `qadam_metadata.contextVersion` (`1` / `2` / `NONE` / `UNRECOGNISED`; `NULL` is unknown).
- **Unresolvable**: no qadam version on this instance answers the pin — unknown, which counts as still needing the old contract.

## Surfaces
- **`doctor`** (`npm run doctor`, or `docker compose run --rm --entrypoint node app packages/server/api/dist/src/scripts/framework-census-doctor.js`) lists the steps that will stop running; `--fail-on-findings` exits 1. The release itself never blocks.
- **`GET /v1/framework-census`** returns the platform's census for the admin UI/banner.
- **MCP**: `ap_flow_structure` marks an affected step `⚠️ FRAMEWORK VERSION NO LONGER SUPPORTED: update this step` and carries `frameworkVersionSupported: false`; `ap_validate_flow` reports the `framework_version` category.
- **Boot log**: one warning line when the release has retired a context version.

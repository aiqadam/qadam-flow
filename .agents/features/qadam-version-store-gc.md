# Qadam Version Store GC & Registry Config

## Summary
#478, delivering ADR-0003's "GC" and ADR-0004's "Store (#478)". A daily system job collects a
stored qadam version only when it is not pinned by any flow version (drafts included), not among
the versions the current image ships, and not one of the last N versions a pin move
(`.agents/features/qadam-pin-moves.md`) left a step pinned to — all together, for at least a
configurable number of days. It also records `QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN`, the
registry a non-`@aiqadam/*` fetch (#806, not built yet) will use, and reports the store's total
size as a metric with an operator warning above a configurable threshold.

## Key Files
- `packages/server/utils/src/qadam-version-store/qadam-version-store-gc-decision.ts` — the pure
  decision, no I/O, mirroring `qadam-pin-fallback-decision.ts`'s own split: `classify` sorts stored
  coordinates into protected / unreferenced given the pinned, image-shipped and retained-by-move
  sets; `selectEligible` picks the ledger entries whose grace period has elapsed; `coordinateKey`
  is the one place that decides an official qadam's coordinate always uses the `null` namespace
  regardless of which platform's flow references it.
- `packages/server/utils/src/qadam-version-store/qadam-version-store-gc-ledger.ts` — when GC first
  saw a version unreferenced, kept beside the store (`qadam-gc-ledger.json`) the same way
  `qadam-signature-ledger.ts` keeps npm signatures: not part of any version, atomic whole-file
  writes, read as empty rather than refused on anything unusable. The grace period is tracked from
  here, not from `storedAt` — a version pinned for a year and dropped an hour ago still gets the
  full window. `reconcile` is the only operation: given this run's full unreferenced set, a new
  coordinate starts its clock at `now`, an already-tracked one keeps its original timestamp, and
  one no longer offered (referenced again, or already collected) is dropped. GC is the only writer
  and runs under one lock, so there is nothing to merge against.
- `packages/server/utils/src/qadam-version-store/qadam-version-store.ts` — `remove` (move the
  version aside with one atomic rename, then delete, mirroring the damaged-version replace path, so
  a reader never sees a half-deleted version), `listAllVersions` / `listPlatformNamespaces` (every
  version across the official and every platform namespace, for a sweep that must see the whole
  store — `listVersions` alone only covers one namespace at a time).
- `packages/server/utils/src/qadam-version-store/qadam-version-store-seed.ts` —
  `listImageVersions` reads the current image's own `archive-index.json` to answer "what does the
  running image ship right now". A stored version's own `origin.kind === IMAGE_SEED` is not enough:
  it is written once and never updated, so it cannot tell "some past image seeded this" from "the
  current image still ships it" — the distinction ADR-0003's "never collect what the image ships"
  rule needs (otherwise an upgrade that drops a qadam would have GC collect it, and the next
  rollback would have nothing to re-seed from).
- `packages/server/api/src/app/qadams/version-store/qadam-version-store-gc.ts` — the orchestrator:
  opens the store, gathers the pinned set (every `flow_version` row on the instance, not only the
  latest and published ones — a run can still be retried against an older LOCKED version, so this
  errs toward never deleting a version something might still need), the image-shipped set, and the
  retained set (a `ROW_NUMBER() OVER (PARTITION BY "flowId", "stepName", "qadamName" ORDER BY
  "created" DESC)` window over `qadam_pin_move`, keeping the top N per step), hands them to
  `qadamVersionStoreGcDecision`, reconciles the ledger, deletes what is eligible, and reports the
  store's remaining size. Registered as `SystemJobName.QADAM_VERSION_STORE_GC`
  (`qadam-context-version-backfill.ts` is the template this follows), scheduled from `app.ts` next
  to it. Runs under one `distributedLock` so replicas never scan or delete concurrently.
- `packages/server/api/src/app/qadams/version-store/qadam-version-store-metrics.ts` — the
  `qadam_flow.qadam_version_store.bytes` observable gauge (the `long-polling-host.ts` pattern: a
  module-level last-known value, one `createObservableGauge` registration), updated after every GC
  run; the operator warning above a configurable byte threshold is a plain `log.warn` in the GC
  module itself, not a separate mechanism.
- `packages/server/api/src/app/qadams/version-store/qadam-registry-config.ts` — `get()` reads
  `AP_QADAM_REGISTRY_URL` (default npmjs) / `AP_QADAM_REGISTRY_TOKEN` (no default); `checkReachability`
  probes `<url>/-/ping` through `safeHttp.createAxios` (the URL is admin-configured, so it must go
  through the SSRF filter per `.agents/rules/safe-http.md`) and treats any HTTP response, even a 404
  or 401, as reachable — only a network-level failure is not. The token travels only as a bearer
  header and is never put in a log call; `get()` returns it because a caller (the fetch path, #806)
  needs the value, not because it is safe to print.
- `packages/server/api/src/app/helper/system/system-props.ts` / `system.ts` /
  `system-validator.ts` — `QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN` /
  `QADAM_VERSION_STORE_GC_CRON` / `QADAM_VERSION_STORE_GC_RETENTION_DAYS` (default 10) /
  `QADAM_VERSION_STORE_GC_KEEP_LAST_N_VERSIONS` (default 3) / `QADAM_VERSION_STORE_SIZE_WARN_BYTES`
  (default 5 GiB).

## Domain Terms
- **Unreferenced** — a stored version that is not pinned by any flow version, not shipped by the
  current image, and not one of a step's last N retained revert targets. Tracked from the moment
  GC first observes it this way (`qadamVersionStoreGcLedger`), not from when it was stored.
- **Retained** — a version a pin move (`qadam_pin_move`) left a specific step pinned to, within the
  configured count of most-recent moves for that exact `(flowId, stepName, qadamName)` — what a
  revert reaches back into, kept even past the retention window.

## Not done yet
- **Registry fetch (#806) and image seeding (#807)** do not exist yet. `qadamRegistryConfig` only
  records where a fetch would go; nothing calls `checkReachability` automatically (it is exposed for
  #806/#807 to call), and `run.sh` does not prompt for or pass these variables (#807's job per the
  issue's own scoping).
- **Framework version in audit records and the census** (ADR-0004: "record each snapshot's exact
  framework version... and show it in audit records and the framework census"). The version-store's
  `integrity.json` already carries `builtAgainst` (#851), but surfacing it in `qadam_pin_move` or in
  `framework-census-service.ts` needs the pin-move service and the census to read the version store
  directly, which neither does today (the census is explicit about this:
  `.agents/features/framework-census.md`, "until #779 reads the local store"). Left for whichever of
  #779 / #808 / #851's own follow-up wires that read.
- **GC ahead of #806.** `.agents/features/qadam-pin-moves.md` noted the retention/GC work as
  "blocked by #806" before ADR-0004 (accepted 2026-10-10) assigned the full GC rule to #478
  regardless. Shipping GC before the fetch path exists means a version GC collects cannot be
  healed by re-fetching it today — accepted here as a stated risk, not a design gap: GC never
  collects a version anything currently needs, by construction, and the fetch path only widens what
  can be *recovered* after a wrong call, not what GC is allowed to make.

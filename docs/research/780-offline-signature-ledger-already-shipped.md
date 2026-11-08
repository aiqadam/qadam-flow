# #780 — Persist signature verification next to the store: built by #881, with the store writer and container e2e still elsewhere

**Status:** no code change under this ticket today. The worker-side persistence and every
state-carrying restart test are shipped by #881; the store-side ledger writer is #806's fetch by
design, and a true container restart e2e has no input until an image seeds the store (#807) and no
ticket of its own after #881.
**Investigated:** 2026-10-25, on `agent/780-offline-readiness-persist-signature-veri`
(branched from `main` @ `97a61649`).

## What the issue asks now

The 2026-10-08 comment re-scoped the original body under ADR-0003:

1. **Image cache seeding** — replaced by seeding the versioned store from the image; owned by
   #805 / #807, not this ticket.
2. **Signature verification after every restart** — still in scope: verified triples persist next
   to the store, so a restart does not need the registry for versions already verified.
3. **Quarantine for `@aiqadam/*`** — moved to #806, where fetching lives.
4. **Test** — no outbound network, warm volume, worker restart, and flows pinned to versions in
   the store still run.

## What #881 shipped

PR [#881](https://github.com/aiqadam/qadam-flow/pull/881) merged on 2026-10-10 as `dbb05fe1`,
which is an ancestor of this branch. ADR-0005 already records it as "#780, merged as #881"
(`adr/0005-store-trusts-npm-signature-not-release-age.md:171-172`).

The ledger stores the **proof**, not a verdict — npmjs's signature over
`<name>@<version>:<integrity>` — and every lookup verifies it again offline against the keys
pinned in the image. An edited, copied, stale or unreadable record falls back to the registry;
offline that still refuses, exactly as before:

| Layer | Where it lives now | Evidence |
| --- | --- | --- |
| Signature check + pinned npmjs keys | `packages/server/utils/src/npm-package-signature.ts` | `NPM_SIGNING_KEYS` at `:31`, `npmPackageSignature` at `:35` |
| Ledger (atomic write, merge, eviction, format version) | `packages/server/utils/src/qadam-version-store/qadam-signature-ledger.ts` | `open` `:69`, `check` `:77`, `checkStoredVersions` `:103`, `checkStored` `:117`, `record` `:122` |
| Store-side file, beside the store root | `packages/server/utils/src/qadam-version-store/qadam-version-store-layout.ts` | `signatureLedgerFile: 'qadam-signatures.json'` `:33`, layout comment `:15-19` |
| Worker: read the ledger before the registry, persist what the registry verified | `packages/server/worker/src/lib/cache/qadams/qadam-integrity.ts` | ledger opened over `rootWorkspace` `:84-91`; proofs persisted in `finally` `:121`, `persistProofs` `:455` |
| Image-seed / custom-qadam exemptions, decided inside `checkStored` | `qadam-signature-ledger.ts` | `classifyStored` `:183-195` |
| Restart test, worker pass | `packages/server/worker/test/lib/cache/qadams/qadam-integrity.test.ts` | `describe('qadamIntegrity.verifyOfficialQadams after a worker restart')` `:582`, including "no registry call at all" `:610` |
| Restart test, store + ledger | `packages/server/utils/test/qadam-version-store-offline-restart.test.ts` | file header `:13-21`; warm volume, registry fails every call, all stored versions verified, `0` registry calls `:46-58`; read-only worker reader `:60-70` |
| Restart test, engine loads with no network | `packages/server/engine/test/helper/qadam-version-store-resolution.test.ts` | `:108-126` (spies on `fetch`, `net.Socket#connect`, `dns.lookup`) |

For official qadams the worker's `rootWorkspace` is `cache/v13/common`
(`packages/server/worker/src/lib/cache/cache-paths.ts:10-21`; official verification always uses
`getGlobalCacheCommonPath()`, `qadam-installer.ts:645`). `./cache` is a bind mount on both API and
worker (`docker-compose.yml:15,46`), so that ledger survives a container restart. The store root is
the `qadam_versions` volume (`docker-compose.yml:22,50`).

## What #881 deliberately left open

#881's own merged body says why it was `Part of #780` and not `Closes`:

> Nothing records into the store's ledger yet: that is the fetch of #806 (it must call `ledger.record` with
> the signatures it verifies online, and `checkStored` at start-up). That and the worker-restart e2e
> on a real container are why this is `Part of #780` and not `Closes`.

That remains true on this branch, so "shipped by #881" must not be read as "all of #780 is done".

## What remains, and where it actually lives

- **Item 1 (image seeding).** #805's store is merged (`#829`), but no image seeds it yet: there is
  no `packages/qadams/version-store-seed` directory in the tree (the default
  `QADAM_VERSION_STORE_SEED_PATH`, `packages/server/api/src/app/helper/system/system.ts:37`), and
  the Dockerfile has no seed step. That is #807's `:fat` / `:slim` work, as the re-scope says.
- **Item 3 (quarantine).** Moved to #806; ADR-0005 records the decision and the fetch path is
  #806's to build.
- **Store-side ledger writes.** The ledger API is present and tested, but nothing in production
  writes the store's ledger yet: that is #806's fetch, exactly as #881's body said
  (`.agents/features/pieces.md:198`). Today the store is empty on a fresh install: the only
  production writer is seeding (`qadam-version-store-seeding.ts:49`), which is a no-op until #807
  ships a seed (`qadam-version-store-seed.ts:16`), and image seeds are exempt from the signature by
  design (`qadam-signature-ledger.ts:188-190`). There is therefore no offline gap this ticket can close
  today.
- **A true container-level restart e2e.** #881 modelled the restart at every layer that carries
  state, because CE tests have no container lifecycle and the check runs inside `bun install`'s
  lock. A real container test also needs an image that actually seeds the store (#807) and, to
  exercise the ledger rather than only the seed exemption, #806's fetch — until then there is
  nothing in the store to restart with.
- **Runtime resolution remains #779's**, with remaining slices called out in its own thread; the
  engine's store-first resolution is already in `qadam-loader.ts:282-284`.

## Verification

Run on this branch after `bun install --ignore-scripts` (no C toolchain in this sandbox for
`isolated-vm`'s native build, unrelated to these files):

```bash
cd packages/server/utils
npx vitest run test/qadam-signature-ledger.test.ts \
  test/qadam-signature-ledger-io.test.ts \
  test/qadam-version-store-offline-restart.test.ts
# 3 files, 50 tests passed

cd packages/server/worker
npx vitest run test/lib/cache/qadams/qadam-integrity.test.ts
# 1 file, 50 tests passed
```

Also verified that `dbb05fe1` is an ancestor of this branch (`git merge-base --is-ancestor
dbb05fe1 HEAD`) and that the references above still point at the code they claim.

## Recommendation

- **Do not close #780 as "already shipped" yet.** #881's stated reason for leaving it open — the
  store ledger writer and the real container restart e2e — is still correct. Closing it on this
  note would drop both.
- **Keep the store ledger writer in #806**, where #881 put it; it is the same fetch that must call
  `ledger.record` and the start-up `checkStored` sweep.
- **Give the container restart e2e a home.** It is not in #807's scope (images, `run.sh`, docs,
  CI smoke) and #881 says it belongs to #780. Either add it to #807 when that image first carries a
  seed, or open a small follow-up gated on #807 + #806. Once that ticket exists, #780 has no code
  left and can close.
- Do not write a second signature store or a one-line "persist the triples" patch: the ledger is
  the persistence, and duplicating it would create the two-sources-that-drift problem ADR-0003
  rejected for artifacts.

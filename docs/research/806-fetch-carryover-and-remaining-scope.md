# #806 — Fetching is shipped; the #477 carry-over re-check and what is left

**Status:** the fetch path ADR-0003 "Fetching" asked for is merged into `main` as PR
[#969](https://github.com/aiqadam/qadam-flow/pull/969) (squash `542f25a4`, 2026-10-25). The
branch `agent/806-fetch-missing-qadam-versions-into-the-st` now merges `main` (through
`d46bc8c7`); the feature diff against `main` is empty, so the "conflicts with `main`" fix-up is
complete and this document is the only addition. What remains on the issue is the custom-qadam half
and the #477 carry-over re-check below.
**Investigated:** 2026-11-07, on `agent/806-fetch-missing-qadam-versions-into-the-st` @ `87c169db`
(a merge of `origin/main` @ `d46bc8c7`).

## What shipped, and where

| Scope item | Where it lives | Evidence |
| --- | --- | --- |
| Fetch on publish (`LOCK_AND_PUBLISH`) | `packages/server/api/src/app/flows/flow/flow.service.ts` | `fetchMissingQadamPins` `:849`, called for a `DRAFT` before `moveUnavailableQadamPins` `:553` |
| Fetch on import (`IMPORT_FLOW`) | `packages/server/api/src/app/flows/flow-version/flow-version-validator-util.ts` | `qadamVersionFetch(log).fetchMissingStepPins(...)` `:230`, before validity is recomputed |
| Background fetch at start-up | `packages/server/api/src/app/qadams/fetch/qadam-version-fetch-startup.ts` | floating `void qadamVersionFetchStartup({ log: app.log }).run()` in `app.ts`; `distributedLock` `:53`, drafts + current published versions `:105` |
| Candidate selection (official, exact release, not already available) | `packages/server/api/src/app/qadams/fetch/qadam-version-fetch.ts` | `collectCandidates` `:101`; `filterMissing` calls `qadamMetadataService.isPinAvailable` |
| Signature reuse (#482) + persisted verification (#780) | `packages/server/utils/src/qadam-version-store/qadam-version-store-fetch.ts` | `npmPackageSignature.verifying` `:86`, refuse on `UNSIGNED` `:87`, `ledger.record` `:111` |
| `minimumReleaseAge` exemption | `adr/0005-store-trusts-npm-signature-not-release-age.md` | ADR-0005 §1: the signature over the exact pin replaces release-age quarantine |

The design boundaries the PR deliberately holds: a range pin, a `-main.` snapshot pin and a custom
(non-`@aiqadam/*`) pin are **not** candidates; only an exact official release is. A pin the fetch
cannot land is left exactly as it was for the unavailable-version fallback (#808).

## The #477 carry-over, re-checked against the store design

The issue asks to re-check each #593/#652 item "against the store design before implementing". The
five items all describe the **legacy `0.x` bun-workspace install** (`qadam-installer.ts` /
`qadam-integrity.ts`), which the store path does not use. They are not gaps in #806's fetch:

| #477 item | Legacy mechanism it guards | Store equivalent | Verdict |
| --- | --- | --- | --- |
| Lock fencing | `fileLock` on the shared `common` workspace; `isCompromised()` narrows (never closes) a window where two replicas write one `bun.lock` | The store has no shared lockfile. A version is assembled in `.staging/` and `rename(2)`d into place; two writers both stage, one rename wins and the loser discards its copy (`qadam-version-store.ts` `:43-45`, `publish` `:165-183`). Two writers of the same version are safe by the filesystem, not by a lock. | **Not applicable** — nothing to fence. |
| Unverified flag-off `ready` markers | A member directory without a `ready` file marks an install that stopped; the next install removes it | The store writes `integrity.json` last and renames atomically, so a version is complete or absent; there is no `ready` marker and no partial member to adopt (`.agents/features/workers.md`, "What is still open"). | **Not applicable** — no markers. |
| Refusals excused per lockfile key, not per dependent | `bun.lock` refusals can be excused by a leftover install; #593 makes a snapshot with any refusal fail closed | The store never resolves dependencies and never reads or writes `bun.lock`; the tarball's bytes are held to the signed `dist.integrity` before `putTarball` (`qadam-version-store-fetch.ts` `:95-111`). | **Not applicable** — no lockfile. |
| Orphan official-name ARCHIVE members | bun installs an ARCHIVE dependency under a name-shaped path; `removeAbandonedMembers` must not remove a ready qadam | The store's coordinates are validated (`validateCoordinates`) and a name cannot use a reserved segment; there are no workspace members to orphan. `QadamVersionOrigin.ARCHIVE` is an artifact-format marker, not a workspace member. | **Not applicable** — no members. |
| Fail-closed decision | An `@aiqadam/*` entry with no verifiable signature fails the install, and an unknown key id is never "allow" | The fetch refuses before extracting or storing when no pinned-key signature verifies the name, version and integrity (`qadam-version-store-fetch.ts` `:86-88`), and `isTrustedTarballUrl` keeps the download on the registry's own https origin. | **Already implemented** on the store path. |

One consequence worth stating plainly: the legacy path still exists behind
`OFFICIAL_QADAMS_INSTALL_ENABLED` (default off), and none of these items is "fixed" there by this
ticket. They are simply not part of the store-based fetch, which is the path ADR-0003 chose. If the
legacy flag is ever turned on, its own checklist applies unchanged.

## What is still open on the issue

### Custom-qadam fetch and the signature setting

`#478` now ships `AP_QADAM_REGISTRY_URL` / `AP_QADAM_REGISTRY_TOKEN` and
`qadamRegistryConfig` (`packages/server/api/src/app/qadams/version-store/qadam-registry-config.ts`),
but **nothing consumes that config in production** — only its own test calls it. The fetch is
official-only:

- `collectCandidates` drops a non-`@aiqadam/*` name (`qadam-version-fetch.ts` `:109`);
- `fetchFromRegistry` always stores under the official namespace (`platformId: null`,
  `qadam-version-store-fetch.ts` `:100`), while a custom version belongs under
  `_platform/<platformId>/…` (`qadam-version-store-layout.ts`).

Wiring custom fetching is not a drop-in: ADR-0005 §2 forbids asking **npmjs** for a custom name
(privacy leak + anyone could answer), so a custom pin may only be fetched from a **non-default**
configured registry; and the "signature check for custom qadams" setting has no defined trust
anchor yet, because the pinned keys are npmjs's and a private registry's private packages are not
signed by them. Enabling the check against the npmjs keys only verifies a custom package that is a
verbatim npmjs mirror, which is a coherent but narrow first slice. That is why the merged PR left it
out and why it needs its own decision rather than a guessed default.

### What a follow-up needs

1. A decision (or an ADR addendum) on the custom signature trust anchor: pinned npmjs keys only,
   configurable keys per registry, or "off means no check, on means npmjs keys only".
2. Thread `platformId` and the configured registry URL/token through
   `fetchFromRegistry` → `putTarball`, with the token kept out of logs (the existing
   `qadamRegistryConfig` comment is the rule).
3. A system prop for the setting, default off, plus validator and docs.
4. Tests: a custom pin is skipped on the default registry; fetched from a configured one; stored
   under the platform namespace; and refused when the setting is on and no pinned key verifies.

## How to check this document's claims

```bash
git diff --stat origin/main HEAD -- . ':!docs/research/806-fetch-carryover-and-remaining-scope.md'
                                          # empty: the only change on the branch is this document
git log --oneline origin/main..HEAD       # the pre-squash branch commits, content already in main
grep -n "isOfficialQadamName" packages/server/api/src/app/qadams/fetch/qadam-version-fetch.ts
grep -rn "qadamRegistryConfig" packages/server --include=*.ts | grep -v test
cd packages/server/utils && npx vitest run test/qadam-version-store-fetch.test.ts
cd packages/server/api && npx vitest run test/unit/app/qadams/qadam-version-fetch.test.ts \
  test/unit/app/qadams/qadam-version-fetch-startup.test.ts \
  test/unit/app/qadams/qadam-version-store-access.test.ts
```

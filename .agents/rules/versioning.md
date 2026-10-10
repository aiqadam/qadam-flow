# Versioning — what a version number promises, and how it moves

Every version number in this repo is a semver promise to a named consumer: [ADR-0001](../../adr/0001-everything-versioned-follows-semver-declared-with-changesets.md)
(the scheme) and [ADR-0002](../../adr/0002-two-framework-majors-supported-for-at-least-12-months.md)
(the framework support window). This file is the one place the rules are restated; where it and an
ADR disagree, the ADR wins. The procedure — choosing a level, applying it — is the `versioning` skill.

## What each number means

| Layer | Contract with | major | minor | patch |
| --- | --- | --- | --- | --- |
| Platform (root `package.json`, release tag, images) | instance operators | the upgrade needs operator action — always with an entry in `docs/install/configuration/breaking-changes.mdx` | new capability | fix |
| SDK — `@aiqadam/qadams-framework`, `@aiqadam/qadams-common` | qadam authors | a broken public API, or a new engine ↔ qadam `context` version | new export | fix |
| Qadam | flows that pin it | an action, trigger or prop removed or renamed; a new required prop without a default; a narrowed type; a changed output shape; **or a behaviour change an existing step would notice** | new action or trigger, optional prop, new output field | fix that changes none of the above |
| `@aiqadam/shared` | nobody outside the repo — private and bundled into `qadams-framework` since #799 | — | — | — |

- **On `0.x` the breaking slot is minor** (`0.4.15` → `0.5.0`); everything non-breaking is patch,
  except a new named export from a package entry, which this repo puts on minor. Read the current
  version before choosing: today only `qadam-assemblyai` (`2.0.0`) is past `1.0.0`. Qadams move to
  `1.0.0` one by one, each at its next change. The SDK makes no compatibility promise before
  `qadams-framework@1.0.0` / `qadams-common@1.0.0` (#786).
- **The behaviour question is yours to answer.** A qadam change that keeps the schema but changes
  what an existing step does (#397's `secret_token`, #393's long polling) is breaking. No gate can
  see it; say in the PR which way you answered and why.
- **When a change fits no row, take the higher level.** A level that is too low breaks a consumer;
  gate 2 (#797) rejects a level only as too low, never as too high.
- **A version is never reused or republished.** npm answers 403, and a skipped publish is silent.
- **`shared` is private and no longer published (#799).** `qadams-framework` ships all of it — every
  file of its build, code and `.d.ts` — inside its own tarball, and re-exports from it, so a change
  to `shared` is a change to what the framework ships and is declared on `qadams-framework` too, at
  the SDK level (gate 1 requires the changeset; the level is the `versioning` skill's call).
  `shared` itself stays a versioned package inside the repo (`.changeset/config.json` sets
  `privatePackages.version`) because the framework depends on it at source level, but no `shared`
  version reaches npm again.

## The caret-range promise

A version inside `^` of a pin (`^1.2.3` → `<2.0.0`, `^0.3.1` → `<0.4.0`) is a drop-in replacement at
the contract level. Anything that moves a pin automatically may move it only inside that range —
`qadamPinFallbackDecision` (`packages/server/utils/src/qadam-pin-fallback-decision.ts`, #808) is the one place that rule is written for a move. Moving a pin across it is a user
action in the builder, never a resolver, migration or job. The only exception since this rule is the
one-off heal `migrate-v31-heal-unresolvable-qadam-pins.ts` (#474), which still runs once per flow
version and may cross the range; the legacy `v24`–`v30` republish migrations
(`packages/server/api/src/app/flows/flow-version/migrations/index.ts`) predate it and can still
rewrite an `ai` pin when an old flow version is migrated — they are history, not a precedent. Do not
add another.

## Compatibility floors

`minimumSupportedRelease` / `maximumSupportedRelease` are **platform-release floors** in Qadam Flow
release numbers — nothing else. The engine ↔ qadam contract is the framework major (ADR-0002). The
framework raises any declared floor below `MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION`
(`0.82.0`, `packages/qadams/framework/src/lib/context/versioning.ts`) to that value, so the 234
official qadams that declare `'0.0.0'` really report `0.82.0`. Leave the field out unless the qadam
needs a platform capability first shipped in a specific Qadam Flow release, and then set it to that
release. Never copy an Activepieces-era number (`0.36.1`, `0.58.0`): they name releases of another
product. Gate 7 (#797) checks every floor against the current platform version.

## Framework support window (ADR-0002)

From `qadams-framework@1.0.0`, a new `context` version is a new **framework major**, and the platform
runs qadams built against the **current and the previous major**. The previous major stays supported
for **at least 12 months after the next major is released**, even if a third major ships in that
time. A framework major needs a row in the support table and keeps the engine shim for the previous
major; it needs no operator action, so it is not a platform major. **Retiring** a major — removing
its shim — is a platform major, with its `breaking-changes.mdx` entry. Today's shims (context V1, and
qadams predating `getContextInfo`) sit in a `0.x` row whose successor is `1.0.0`, so they go no
earlier than 12 months after `1.0.0`; the old `Remove after 2026-10-12` date is withdrawn. The
support table and gate 8, which fails a removal the table does not allow, landed in #801 (PR #814).

## Who raises versions: changesets (ADR-0001)

A PR that changes a versioned package adds a `.changeset/*.md` naming each package, its level and
one line on what changed. The release PR collects them, raises versions (dependents inside the repo
included) and writes changelogs; a maintainer then folds `## Unreleased` of `breaking-changes.mdx`
into the new version's section and tags (the `versioning` skill, "Cutting a release"). Root
`package.json` (and `@aiqadam/platform`) holds the last released version — `1.1.0` until the first
release PR takes it to `2.0.0` with the pending platform `major` — and only the release PR moves it. Images built from `main` report `<next>-main.<n>`: the
root raised by the pending platform changesets (at least a patch), with `<n>` the CI run number
(`node tools/ci/compute-main-version.mjs --next` prints `<next>`, the release a change merged now
ships in — e.g. a migration's `release`). How a `main` build versions *changed package* code
is [ADR-0004](../../adr/0004-main-builds-give-changed-packages-their-own-prerelease-versions.md),
accepted on 2026-10-10 and binding (snapshot `-main.<n>` versions, the `follow`/`pin` snapshot policy, export rewriting, gate 9). `tools/scripts/qadams/snapshot/` computes which version each qadam would get in a `main` build (#851); the image does not apply it yet. `@aiqadam/shared` is private and bundled
into `qadams-framework` (#799). Gates 1–7 (#797) and gate 8 (#801, landed) are required; the maintainer-only
`semver-override` label bypasses gate 2 alone, when CI over-estimates the level.
Gate 9 (ADR-0004, #852) is **advisory** until the `0.x` clean-up is done: ci.yml's `qadam-divergence` job
runs `tools/ci/check-qadam-divergence.mjs`, which warns when a `0.x` qadam's tree build differs from its
npm tarball under the same version and no pending changeset covers it. `tools/ci/measure-qadam-divergence.mjs`
prints the full list (it needs a built tree and the registry). It becomes required when that list is empty,
before `v2.0.0` is tagged. Until then a PR is not blocked by it. A changeset for a divergent qadam
shrinks the gate's list at once; the measurement's list shrinks once the release publishes that qadam.


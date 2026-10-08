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
| `@aiqadam/shared` | nobody outside the repo (once #799 lands) | — | — | — |

- **On `0.x` the breaking slot is minor** (`0.4.15` → `0.5.0`); everything non-breaking is patch,
  except a new named export from a package entry, which this repo puts on minor. Read the current
  version before choosing: today only `qadam-assemblyai` (`2.0.0`) is past `1.0.0`. Qadams move to
  `1.0.0` one by one, each at its next change. The SDK makes no compatibility promise before
  `qadams-framework@1.0.0` / `qadams-common@1.0.0` (#786).
- **The behaviour question is yours to answer.** A qadam change that keeps the schema but changes
  what an existing step does (#397's `secret_token`, #393's long polling) is breaking. No gate can
  see it; say in the PR which way you answered and why.
- **When a change fits no row, take the higher level.** A level that is too low breaks a consumer;
  gate 2 (#797) will reject a level only as too low, never as too high.
- **A version is never reused or republished.** npm answers 403, and a skipped publish is silent.
- **`shared` is still published until #799.** Every published qadam pins an exact `@aiqadam/shared`
  (`prepareQadamDistForPublish` rewrites `workspace:*`), so until then a break there is a break in
  the whole catalogue's install graph; version it like the SDK.

## The caret-range promise

A version inside `^` of a pin (`^1.2.3` → `<2.0.0`, `^0.3.1` → `<0.4.0`) is a drop-in replacement at
the contract level. Anything that moves a pin automatically may move it only inside that range —
#424's bundled fallback (`satisfiesRequestedRange`) is the model. Moving a pin across it is a user
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
product. Gate 7 (#797) will check every floor against the current platform version.

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
included), writes changelogs and tags. Root `package.json` holds the last released version; images
built from `main` report `<next>-main.<n>` (#798). How a `main` build versions *changed package* code
is [ADR-0004](../../adr/0004-main-builds-give-changed-packages-their-own-prerelease-versions.md),
still `proposed` and so not binding (snapshot `-main.<n>` versions, gate 9). Until #798 lands it reads `2.0.0` while the latest
tag is `v1.1.0` (#326): leave it alone outside a release. `@aiqadam/shared` becomes private and bundled
into `qadams-framework` (#799). Gates 1–7 (#797) and gate 8 (#801, landed) are required; the maintainer-only
`semver-override` label bypasses gate 2 alone, when CI over-estimates the level.

## Until #796 and #797 land

**Most of the section above does not exist yet** — no `.changeset/`, no release PR, no
`semver-override` label; the support table and gate 8 landed in #801 (PR #814), and the rest of the
gates arrive with #797. The PR that lands them deletes this section and rewrites, in the same pass,
every statement that a version is bumped by hand: the last two sentences of AGENTS.md's
"Published-package version bumps"; CONTRIBUTING.md's "How a version moves today" bullet and its
PR-checklist line; the first paragraph of `packages/shared/AGENTS.md`; the `versioning` skill's
transition note, step 4 and step 5; the qadam-builder skill's "Versioning an existing piece"
opening, critical reminder 6, its mode-table "Bump the piece version." rows and its required-prop
breaking-slot paragraph; and in `.opencodereview/rules/`, the repo-wide block (identical in
`10`, `20`, `30`, `40`, `60` and `90-*.md`), `40-shared.md`'s "Version bump" and `60-qadams.md`'s
"Version bump on every existing-piece change". Until then:

- **Bump by hand, in the same PR.** A change to what `shared`, `qadams-framework`, `qadams-common`
  or a qadam ships — its `src/**` (`i18n` included) or its own `package.json` — raises that
  package's own `version`, at the level above. Check first whether the branch already bumped it;
  one bump per branch is enough. A comment-only `src/` change still needs one.
- **Nothing cascades.** A `shared` bump does not bump `framework` or `common`; the release PR's
  internal-dependency bumps will.
- **What CI catches today — and nothing else.** `check-qadam-version-bumps` (required, in
  `_verify.yml`) fails when the dependency section of any `packages/qadams/**/package.json` — a
  qadam, `framework` or `common` — changed without a version increase, and
  `qadam-version-bump.yml` applies that bump on Renovate's branches. `check-required-prop-defaults`
  fails a newly required prop with no default unless the version moved into the breaking slot. At
  release, `breaking-change-gate` wants a `breaking-changes.mdx` section when a commit in the range
  has a `type!:` subject (the PR title, after a squash merge) or a `BREAKING CHANGE:` footer, and `version-tag-gate` wants the tag to equal root
  `package.json`. A `src/` change with no bump is caught by nothing: `packagePrePublishChecks` diffs
  against `origin/main`, which on the publish path is the commit itself (#783), so an unbumped
  package reads as already published and is skipped without a word.
- **Do not move a qadam to `1.0.0` on your own.** Whether "each at its next change" starts before
  the first changesets release is not decided; ask a maintainer.

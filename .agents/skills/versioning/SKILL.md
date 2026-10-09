---
name: versioning
description: Chooses and applies the version level for a change to a versioned package — a qadam, @aiqadam/qadams-framework, @aiqadam/qadams-common, @aiqadam/shared or the platform. Use when a diff touches packages/qadams/**, packages/shared or the root package.json version, when writing a changeset, when CI's semver gate disagrees with the level you declared, or when deciding whether the semver-override label applies.
---

# Versioning

[`.agents/rules/versioning.md`](../../rules/versioning.md) says what each version number promises:
the layer table, the `0.x` shift, the caret-range promise, compatibility floors and the framework
support window. This skill is the procedure. Read the rule first; this file does not repeat its tables.

## 1. List the versioned packages the diff touches

```bash
git diff --stat origin/main...HEAD -- packages/shared packages/qadams package.json
```

For each one, note its name, its layer in the rule's table and its current `version`. Versioned:
`packages/shared`, `packages/qadams/framework`, `packages/qadams/common`, and every
`packages/qadams/{core,community}/<name>` — its `src/**` (translations included) and its own
`package.json`. A PR that touches five qadams needs five decisions, one per qadam. The root
`package.json` version is the platform's and moves only in a release (rule, "Who raises versions").

## 2. Choose the level, highest matching row wins

**Qadam** — judge from a flow that already pins the current version and is not edited:

- **major** — an action, trigger or prop removed or renamed (action and trigger `name`s are
  permanent); a new required prop with no `defaultValue` that reproduces the old behaviour (see
  "Adding a prop to an action/trigger that has already shipped" in the `qadam-builder` skill); a
  narrowed type (a dropdown option removed, a looser input rejected); an output field removed,
  renamed or retyped; **or the step, unchanged, now does something different** — #397
  (`telegram-bot` began sending and checking `secret_token`) and #393 (long polling) did that with
  identical schemas.
- **minor** — a new action or trigger; an optional prop; a required prop whose `defaultValue`
  reproduces the old behaviour; a new output field. A new named export from `src/index.ts` (an
  auth, a client factory) also goes here by repo convention; a new action is not an export — no
  consumer imports actions by name.
- **patch** — a fix that changes none of the above.

**SDK** (`qadams-framework`, `qadams-common`) — judge from the public API a qadam compiles against:
a removed or renamed export, a changed signature or a narrowed type is major; a new `context`
version is major and, from `1.0.0`, needs a support-table row and keeps the previous major's engine
shim (ADR-0002, landed in #801/#814); a new export is minor; a fix is patch.

**`@aiqadam/shared`** — private and no longer published since #799, so it has no consumer outside
the repo of its own: a patch changeset on `shared` is enough. But `qadams-framework` re-exports
straight from `shared`, and its tarball vendors all of `shared`'s build — so a `shared` change is
also a framework change, and needs its own changeset on `@aiqadam/qadams-framework` at the **SDK**
level above: judge it from what a qadam reaches through the framework (a re-exported symbol, a type
one of them references, the behaviour of a re-exported function). Nothing a qadam reaches changed →
patch. Without that line the release PR still patches the framework (`updateInternalDependencies`),
so a breaking change to a re-exported symbol would ship as a framework patch; gate 1 fails a
`shared` `src/` or dependency change whose PR has no framework changeset. Usually it is a second
line in the same file:

```md
---
"@aiqadam/shared": patch
"@aiqadam/qadams-framework": minor
---

Narrow `QadamCategory` (re-exported by the framework).
```

Then place the level on the package's line. On `0.x`: major → **minor**, everything else →
**patch**, except a new export, which stays minor. From `1.0.0`: as is. Unsure between two levels?
Take the higher one.

## 3. Write the behaviour answer into the PR body

One line per package: what an existing step would notice (or "nothing"), and the level that follows.
No gate checks this (ADR-0001); the line is how a reviewer checks it.

## 4. Apply the level — a changeset, never a hand edit

1. Check what the branch already did: `git diff origin/main...HEAD -- .changeset/`. One changeset
   per package is enough; if it already declares the level you need, stop.
2. Add the changeset (step 5). Never edit `version` in a package's own `package.json` (or the
   root): only the release PR raises versions, and gate 1 fails a hand edit. The one edit gate 1
   accepts is a realignment of the root and `@aiqadam/platform` to the newest `vX.Y.Z` tag when
   the tree has drifted from it, together with a pending platform changeset that brings the next
   release back to at least the old number (#798 did it once: `2.0.0` → `1.1.0` plus a `major`).
   The rule is in `tools/ci/check-changesets.mjs`, "REALIGNING THE PLATFORM".
3. Changed a qadam's dependencies? Gate 1 requires the changeset. Changed a prop?
   `npm run check-required-prop-defaults` must pass — it accepts the breaking slot declared in a
   changeset (a hand-edited version fails gate 1 instead). On a Renovate branch
   `renovate-changeset.yml` writes the changeset — do not add a second one.
4. A platform change that needs operator action: a `"@aiqadam/platform": major` changeset plus the
   `docs/install/configuration/breaking-changes.mdx` entry — gate 4 fails the PR without the pair.
   `breaking-change-gate` re-checks the version jump at release; a `type!:` subject still counts as
   a breaking marker there, but the changeset is what raises the version.

## 5. Write the changeset

A PR adds a `.changeset/*.md` naming each package, its level and one line on what changed:

```md
---
"@aiqadam/qadam-slack": minor
---

Add the "Schedule message" action.
```

`npx changeset` writes one interactively (or write the file by hand). The release PR
("chore(release): version packages") collects them, raises the versions and their in-repo
dependents, writes the changelogs and deletes the files; it never publishes or tags — a maintainer
tags the merged result, which starts `release.yml`. Format and mechanics: `.changeset/README.md`
and `tools/scripts/changesets/version.mjs`.

## 6. When gate 2 disagrees

Gate 2 computes a level from the actions / triggers / props / output-schema diff (qadams) and fails
when the declared level is lower. The SDK `.d.ts` half is not implemented yet (TODO in
`tools/ci/check-changeset-levels.mjs`), so an SDK change is reported as "not computed" and only
gate 1 applies.

- Assume CI is right first. Read what it reports; if it found a removal or a narrowing you missed,
  raise the level.
- If CI over-estimates — what it calls a break is not one for any consumer — say why in the PR and
  ask a maintainer for `semver-override`. Agents never apply that label.
- Never lower a level to get past a check. A level above the computed one always passes.
- A clean gate 2 says nothing about behaviour: step 3 still applies.

## 7. Cutting a release (maintainers)

1. Merge the release PR ("chore(release): version packages"). It raises the versions and the root,
   and consumes the changesets.
2. Before tagging, merge a docs PR that folds `## Unreleased` in
   `docs/install/configuration/breaking-changes.mdx` into a `## <version>` section for the new root
   version (merge it into an existing `## <version>` if there is one) and leaves an empty
   `## Unreleased`. Do not commit this to the release PR's branch: `changesets.yml` rewrites that
   branch on every push to `main`. The release's `breaking-change-gate` needs a non-empty
   `## <version>` section.
3. Tag the merged result `v<root version>`. That starts `release.yml`, and `version-tag-gate`
   compares the tag with the root.

## 8. When `semver-override` applies

Only for gate 2, only when CI computed a higher level than the change is, and only when a maintainer
agrees and applies it; every use stays visible on the PR. It does not cover a missing changeset
(gate 1), a version already published (gate 3), a floor or support-table failure (gates 7 and 8),
or a major you would rather not ship.

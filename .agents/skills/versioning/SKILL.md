---
name: versioning
description: Chooses and applies the version level for a change to a versioned package — a qadam, @aiqadam/qadams-framework, @aiqadam/qadams-common, @aiqadam/shared or the platform. Use when a diff touches packages/qadams/**, packages/shared or the root package.json version, when writing a changeset, when CI's semver gate disagrees with the level you declared, or when deciding whether the semver-override label applies.
---

# Versioning

[`.agents/rules/versioning.md`](../../rules/versioning.md) says what each version number promises:
the layer table, the `0.x` shift, the caret-range promise, compatibility floors and the framework
support window. This skill is the procedure. Read the rule first; this file does not repeat its tables.

**Transition status.** Changesets (#796) and the CI gates (#797) are not in the repo yet. Steps 1–4
are how a level is chosen and applied today. Steps 5–7 describe ADR-0001's target and do nothing
until those tickets land; #796 replaces step 4 and fills in step 5.

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

**`@aiqadam/shared`** — until #799 makes it private it is still published and pinned exactly by
every published qadam, so judge it like the SDK.

Then place the level on the package's line. On `0.x`: major → **minor**, everything else →
**patch**, except a new export, which stays minor. From `1.0.0`: as is. Unsure between two levels?
Take the higher one.

## 3. Write the behaviour answer into the PR body

One line per package: what an existing step would notice (or "nothing"), and the level that follows.
No gate checks this (ADR-0001); the line is how a reviewer checks it.

## 4. Apply the level — today, by hand

1. Check what the branch already did: `git diff origin/main...HEAD -- <package>/package.json`. One
   bump per branch: if it already reaches the level you need, stop; if it is lower, raise it from
   the `origin/main` version, not on top of the branch's bump.
2. Edit `version` in the package's own `package.json`, then `bun install` and commit the matching
   `version` line in `bun.lock` with it (#795 is a recent example).
3. Changed a qadam's dependencies? `npm run check-qadam-version-bumps` must pass. Changed a prop?
   `npm run check-required-prop-defaults` must pass. On a Renovate branch `qadam-version-bump.yml`
   makes the bump — do not add a second one.
4. A platform change that needs operator action: give the PR a `type!:` title — squash merges use it
   as the commit subject, which is what the gate reads — or put a `BREAKING CHANGE:` footer in a
   commit, and write the `docs/install/configuration/breaking-changes.mdx` section;
   `breaking-change-gate` checks it at release.

## 5. Write a changeset — after #796 (stub)

Not available yet. Under ADR-0001 a PR adds a `.changeset/*.md` naming each package, its level and
one line on what changed. The file format, the command and how the release PR consumes it are
#796's to define, and it fills in this step. Do not create `.changeset/` by hand before then:
nothing reads it, and gate 1 does not exist to require it.

## 6. When gate 2 disagrees — after #797

Gate 2 computes a level from the public `.d.ts` diff (SDK) or the actions / triggers / props /
output-schema diff (qadams) and fails when the declared level is lower.

- Assume CI is right first. Read what it reports; if it found a removal or a narrowing you missed,
  raise the level.
- If CI over-estimates — what it calls a break is not one for any consumer — say why in the PR and
  ask a maintainer for `semver-override`. Agents never apply that label.
- Never lower a level to get past a check. A level above the computed one always passes.
- A clean gate 2 says nothing about behaviour: step 3 still applies.

## 7. When `semver-override` applies

Only for gate 2, only when CI computed a higher level than the change is, and only when a maintainer
agrees and applies it; every use stays visible on the PR. It does not cover a missing changeset
(gate 1), a version already published (gate 3), a floor or support-table failure (gates 7 and 8),
or a major you would rather not ship.

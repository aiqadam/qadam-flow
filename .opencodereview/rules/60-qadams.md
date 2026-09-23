# Qadams conventions

Scope: `packages/qadams/**`. Source: root `AGENTS.md` and `packages/qadams/AGENTS.md`.

<!-- repo-wide:start -->
Source: root `AGENTS.md`. These apply to every TypeScript file, in addition to
the language rules OCR already merges from its system layer.

- **No `any`.** Use a precise type, or `unknown` plus a type guard.
- **No type casting.** Do not use `as SomeType` to force a type. If you touch a
  line with an unnecessary cast, removing it is part of the change.
- **No deprecated APIs.** If a used method or export carries a `@deprecated`
  JSDoc tag, it must be replaced with the recommended one.
- **Error handling.** Prefer `tryCatch` / `tryCatchSync` from `@aiqadam/shared`
  (Go-style `{ data, error }`) over `try`/`catch` in server code.
- **Named parameters.** Every function with more than one parameter takes a
  single destructured object. Positional arguments are a finding.
- **Immutable data flow.** A function must return new collections instead of
  mutating a caller-owned array or object. Local mutation inside one function
  body is fine.
- **File order.** imports → exported constants → exported functions → helpers →
  types at the end of the file. A type declared before the code that uses it is
  a finding (paired zod schemas and a small local type above its only consumer
  are the sanctioned exceptions).
- **Comments explain *why*.** Comments that restate *what* the code does are
  noise and a finding.
- **Util files.** Multiple plain functions in one util file are grouped into a
  single exported `const` object; callers use `myUtils.fn1()`. React components
  are named exports instead.
- **Published package versioning.** `@aiqadam/shared`, `@aiqadam/qadams-framework`,
  `@aiqadam/qadams-common` and every qadam publish to npm, so a version is a public
  contract. Any change under one of those packages must bump the version in that
  package's own `package.json`: patch for fixes or non-breaking additions, minor for
  new exports or behaviour changes. They are on `0.x`, where minor is the breaking
  slot; `@aiqadam/qadam-assemblyai` is `1.x`, so a break there is major instead. A
  diff without a version bump is a finding (note the diff may put the two files in
  different review groups — check the changeset, not just this file).
- **Agent knowledge lives in `.agents/`.** `.claude/` and `.cursor/` are
  git-symlink mirrors; editing a mirror instead of `.agents/` is a finding.
<!-- repo-wide:end -->

- **Version bump on every existing-piece change.** A diff touching
  `packages/qadams/{community,core}/<name>/` — `src/**` **or** its own
  `package.json`, since a dependency pin changes what the published tarball
  installs just as a source edit does — must bump
  `packages/qadams/{community,core}/<name>/package.json`'s `version` — a step
  pins the exact qadam version it was built with
  (`flowQadamUtil.getExactVersion`), so an unbumped change is invisible to
  every live flow. Patch for a bug fix, new optional prop, new action/trigger,
  or new output attribute; bump the middle version segment (this repo's
  pre-1.0 stand-in for a semver major, e.g. `0.6.14` → `0.7.0`) for a removed
  action/trigger/prop, a new *required* prop, or any other change to existing
  behaviour. A diff can legitimately touch several qadams in one PR — check
  each changed qadam's own `package.json`, not just one of them.
- **A `StaticDropdown`/`StaticMultiSelectDropdown` prop's own `defaultValue`
  must be one of its own declared `options`** (#427). The framework's
  `staticDropdownSchema` accepts a prop's own out-of-list default so the form
  itself isn't rejected, which just pushes the mismatch downstream to whatever
  reads the resolved value — flag a literal `defaultValue` that doesn't appear
  in a literal `options.options` list, the same check
  `tools/ci/check-dropdown-defaults.mjs` runs statically in CI. If the value
  is a deliberate "unset" sentinel (`''`, `null`) on an optional prop with no
  natural default, dropping `defaultValue` entirely is correct — that is not a
  finding.
- **An action that calls `waitForWaitpoint` declares `pauses` on
  `createAction`** (#426): `true` when every execution waits, `'conditional'`
  when it depends on the step's configuration. Flag a new or changed action
  that waits (directly or through a `common/` helper) without the marker, and
  a marker on an action where nothing waits — `tools/ci/check-pause-markers.mjs`
  runs the same check statically in CI. Creating a waitpoint and returning
  (`create_approval_links`) is not pausing and needs no marker. A PR that adds
  a row to `LEGACY_PAUSING_ACTIONS` in `ap-validate-flow.ts` instead of the
  marker is a finding: that table is frozen to pins predating the marker.
- **Custom API Call's shared props.** `packages/qadams/common/src/lib/helpers`
  defines `StaticDropdown` props (e.g. `body_type`) imported by many qadams'
  Custom API Call action — the same defaultValue/options rule applies there,
  and a mismatch there is higher blast-radius than in a single qadam.

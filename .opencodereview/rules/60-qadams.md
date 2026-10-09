# Qadams conventions

Scope: `packages/qadams/**`. Source: root `AGENTS.md` and `packages/qadams/AGENTS.md`.

<!-- repo-wide:start -->
Source: root `AGENTS.md`. These apply to every TypeScript file, in addition to
the language rules OCR already merges from its system layer.

- **No `any`.** Use a precise type, or `unknown` plus a type guard. Exception:
  `packages/server/{api,utils}/test/**/*.ts`, where ESLint turns `no-explicit-any`
  off (`serverConfigs.api` in `tools/eslint/server.mjs`; both packages lint `test/`) —
  an `any` there is not a finding.
- **No type casting.** Do not use `as SomeType` to force a type. If you touch a
  line with an unnecessary cast, removing it is part of the change.
- **No deprecated APIs.** If a used method or export carries a `@deprecated`
  JSDoc tag, it must be replaced with the recommended one.
- **Error handling.** Prefer `tryCatch` / `tryCatchSync` from `@aiqadam/shared`
  (in qadams: from `@aiqadam/qadams-framework`) (Go-style `{ data, error }`)
  over `try`/`catch` in server code.
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
- **Published package versioning.** Every version is a semver promise to a named
  consumer (ADR-0001; rule: `.agents/rules/versioning.md`). A change that alters what
  `@aiqadam/shared`, `@aiqadam/qadams-framework`, `@aiqadam/qadams-common` or a qadam
  ships — its `src/`, its own `package.json`, or the build config that decides its
  tarball (e.g. `tsconfig.lib.json`) — must be named by a `.changeset/*.md` added in
  the same PR. CI gate 1 is only the mechanical floor: it sees `src/` and `package.json`
  dependency-section changes, so a README-, test- or AGENTS.md-only edit needs none,
  but a manifest or build-config change that alters the tarball still does, though
  gate 1 cannot see it. Only the release PR raises `version`, and a hand-edited version
  is a finding. On `0.x` minor is the breaking slot
  and a new export is minor; everything else is patch. From `1.0.0` (today only
  `qadam-assemblyai`) a break is major, a new capability minor, a fix patch. For a qadam,
  a behaviour change an existing step would notice is a break even with an unchanged
  schema. A diff without a changeset naming the changed package, or at a level below what
  it changes, is a finding (the diff may put the changeset and the package in different
  review groups — check the whole diff, not just this file).
- **Agent knowledge lives in `.agents/`.** `.claude/` and `.cursor/` are
  git-symlink mirrors; editing a mirror instead of `.agents/` is a finding.
<!-- repo-wide:end -->

- **Changeset on every existing-piece change.** A diff touching
  `packages/qadams/{community,core}/<name>/` — `src/**` **or** its own
  `package.json`, since a dependency pin changes what the published tarball
  installs just as a source edit does — must add a `.changeset/*.md` naming
  `packages/qadams/{community,core}/<name>` at the right level — a step
  pins the exact qadam version it was built with
  (`flowQadamUtil.getExactVersion`), so a change the release never picks up is
  invisible to every live flow. Only the release PR raises `version`; a hand
  edit is a finding (gate 1). The levels are ADR-0001's qadam row
  (`.agents/rules/versioning.md`). On a `0.x` qadam: patch for a bug fix, new
  optional prop, new action/trigger, or new output attribute; declare the
  breaking slot (minor, the middle version segment, e.g. `0.6.14` → `0.7.0`) for a
  removed or renamed action/trigger/prop, a new *required* prop with no
  `defaultValue` that preserves the old behaviour, a narrowed type, a changed
  output shape, or a behaviour change an existing step would notice even with
  an unchanged schema (a required prop *with* such a default is a non-breaking
  addition). On a qadam already at `1.0.0` or later the breaking slot is major
  and a non-breaking addition is minor. A diff can legitimately touch several
  qadams in one PR — check each changed qadam's own `package.json` and its
  changeset, not just one of them.
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

# Shared package conventions

Scope: `packages/shared/**`. Source: root `AGENTS.md`.

<!-- repo-wide:start -->
Source: root `AGENTS.md`. These apply to every TypeScript file, in addition to
the language rules OCR already merges from its system layer.

- **No `any`.** Use a precise type, or `unknown` plus a type guard. Exception:
  `packages/server/api/test/**/*.ts`, where ESLint turns `no-explicit-any` off
  (`serverConfigs.api` in `tools/eslint/server.mjs`) — an `any` there is not a finding.
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
  ships — its `src/` or its own `package.json` (`main`, `types`, `exports`, a build config) —
  must be named by a `.changeset/*.md` added in the same PR. CI gate 1 is only the
  mechanical floor: it sees `src/` and `package.json` dependency-section changes, so a
  README-, test- or AGENTS.md-only edit needs none, but a manifest or build-config change
  that alters the tarball still does, though gate 1 cannot see it. Only the release PR raises
  `version`, and a hand-edited version is a finding. On `0.x` minor is the breaking slot
  and a new export is minor; everything else is patch. From `1.0.0` (today only
  `qadam-assemblyai`) a break is major, a new capability minor, a fix patch. For a qadam,
  a behaviour change an existing step would notice is a break even with an unchanged
  schema. A diff without a changeset naming the changed package, or at a level below what
  it changes, is a finding (the diff may put the changeset and the package in different
  review groups — check the whole diff, not just this file).
- **Agent knowledge lives in `.agents/`.** `.claude/` and `.cursor/` are
  git-symlink mirrors; editing a mirror instead of `.agents/` is a finding.
<!-- repo-wide:end -->

- **Changeset — two packages.** Any change that alters what `packages/shared` contributes
  to the framework tarball — its `src/`, or its `package.json` (`main`, `types`,
  dependencies) and build config, which decide what gets vendored — must be named
  by a `.changeset/*.md` added in the same PR, for `@aiqadam/shared` **and** for
  `@aiqadam/qadams-framework`. `shared` is private since #799 and no longer
  published, but the framework re-exports from it and its tarball vendors all of
  `shared`'s build, so what changes here ships to qadam authors as a framework
  change. The framework line's level is the SDK level in
  `.agents/rules/versioning.md`, judged from what a qadam reaches through the
  framework: on `0.x`, minor for a break or a new export, patch for anything else.
  A framework patch for a change to a re-exported symbol's signature or type is a
  finding — gate 1 checks only that the line exists, and the release PR would
  patch the framework anyway. Check whether the branch already adds the
  changesets before flagging — one per package is enough. Flag a missing one even
  for a comment-only diff: gate 1 counts any `src/` change.
- **No `any`, no `as` casts.** This package is the type surface every other
  package consumes; a forced cast here hides errors everywhere.
- **Error helpers.** `QadamFlowError({ code, params })`, `tryCatch`,
  `tryCatchSync` and `formErrors` are the shared primitives; new error paths
  should use them instead of ad-hoc shapes.
- **i18n keys.** Zod messages that surface to users must still be translation
  keys present in all four UI catalogs
  (`packages/web/public/locales/{en,ru,uz,kk}/translation.json` — `npm run
  check-i18n` enforces parity), never raw English.
- **Util exports.** A util file exposing several plain functions exports one
  grouped `const` object (`export const myUtils = { fn1, fn2 }`), not
  individual functions.

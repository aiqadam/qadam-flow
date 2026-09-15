# Shared package conventions

Scope: `packages/shared/**`. Source: root `AGENTS.md`.

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
- **Shared package versioning.** Any change under `packages/shared` must bump
  the version in `packages/shared/package.json`: patch for fixes or
  non-breaking additions, minor for new exports or behaviour changes. A
  `packages/shared` diff without a version bump is a finding (note the diff may
  put the two files in different review groups — check the changeset, not just
  this file).
- **Agent knowledge lives in `.agents/`.** `.claude/` and `.cursor/` are
  git-symlink mirrors; editing a mirror instead of `.agents/` is a finding.
<!-- repo-wide:end -->

- **Version bump.** Any change under `packages/shared` must be accompanied by a
  version bump in `packages/shared/package.json`: patch for fixes and
  non-breaking additions, minor for new exports or behaviour changes. Check
  whether the branch already bumps the version before flagging — one bump per
  branch is enough.
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

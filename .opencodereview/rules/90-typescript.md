# TypeScript conventions (repo-wide)

<!-- repo-wide:start -->
Source: root `AGENTS.md`. These apply to every TypeScript file, in addition to
the language rules OCR already merges from its system layer.

- **No `any`.** Use a precise type, or `unknown` plus a type guard.
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
  consumer (ADR-0001; rule: `.agents/rules/versioning.md`). A change under
  `@aiqadam/shared`, `@aiqadam/qadams-framework`, `@aiqadam/qadams-common` or a qadam
  must be named by a `.changeset/*.md` added in the same PR; only the release PR raises
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

OCR resolves exactly one project rule per file, first match wins, so this block
is copied verbatim into every rule file that can match a TypeScript path
(`10-migrations.md`, `20-server.md`, `30-web.md`, `40-shared.md`).
`tools/ci/test-review.sh` asserts the copies stay identical — edit one, edit
all. The area files add their own conventions after the block.

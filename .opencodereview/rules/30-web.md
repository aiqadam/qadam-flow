# Web conventions

Scope: `packages/web/**`. Source: root `AGENTS.md`.

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

- **White-labeling.** No user-visible surface may hardcode a brand. Sign-in /
  signup pages, email templates, logos and settings must use the platform's
  configured appearance (name, colors, logos). A hardcoded product name or logo
  in user-facing UI is a finding.
- **Zod messages are i18n keys.** Every user-facing validation message must be
  a key that exists in `packages/web/public/locales/en/translation.json`. Raw
  English sentences are a finding.
- **Query error dialog.** A React Query that fetches primary page data (table
  rows, list data) must set `meta: { showErrorDialog: true }`; without it the
  user stares at a blank table with no explanation. Do not add the flag to
  auxiliary queries (feature flags, single-item fetches, filter options).
- **No `any`, no `as` casts** — the same rule as the repo-wide TypeScript
  conventions.

# Database migrations

Scope: `packages/server/api/src/app/database/migration/**`. Source:
`.agents/skills/db-migration/SKILL.md`.

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

- A migration implements the project's `Migration` interface
  (`import { Migration } from '../../migration'`), never TypeORM's
  `MigrationInterface`. Using `MigrationInterface` is a finding.
- `name`, `breaking`, `release` and a `down()` that reverses `up()` are
  mandatory by the project convention — they drive the release manifest and the
  rollback tooling, and the type declaration makes them optional so only review
  catches a missing one. `breaking = true` is correct only when rolling back is
  destructive.
- The class must be registered in `getMigrations()` in
  `packages/server/api/src/app/database/postgres-connection.ts`. A new
  migration file that is not registered is a finding.
- **Prefer additive, non-breaking migrations.** A destructive change (dropping
  a column or table, an irreversible data transform) must be split into safe
  steps across releases: ship the additive/backfill part first and remove the
  old shape in a later release. A single-step destructive migration is a
  finding — say which two steps the change should be split into.
- `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` require
  `transaction = false` on the migration. Missing it is a finding.
- Hand-written SQL where the entity-diff CLI (`npm run db-migration`) could
  have generated the file is a finding — the generated file is then patched
  (interface, fields), not retyped.
- No custom PostgreSQL extensions, and no Enterprise Edition gating: every
  migration ships as CE and runs for all installations.

# @aiqadam/shared

Types, DTOs, Zod schemas, utilities. Every change that alters what this package ships — its
`src/` or its `package.json` (`main`, `types`, dependencies), build config included — adds a
changeset naming this package and its level. CI's gate 1 only detects `src/` and dependency-section
changes, so a manifest or build-config change needs one too even though gate 1 cannot see it,
while a README, test or `AGENTS.md`-only edit needs none. The level is the `versioning` skill's
call, the rule is [`.agents/rules/versioning.md`](../../.agents/rules/versioning.md); only the
release PR raises the version. It is private since #799: `qadams-framework` vendors all of its
build at publish and re-exports from it, so no `shared` version is published again — and such a
change also needs a changeset naming `@aiqadam/qadams-framework`, at the level the change has for
a qadam author. Gate 1 enforces that line for `src/` and dependency changes only; for any other
change that alters the tarball the obligation is ADR-0001's and a reviewer checks it. The
`versioning` skill says how to choose the level.

## Skills for this package

A change here is almost always step 1 of a larger change: read the `add-feature` skill before
adding a schema or export. Full registry:
[`.agents/rules/skill-usage.md`](../../.agents/rules/skill-usage.md).

## Model Pattern

Zod schema + `z.infer` dual export. Use `BaseModelSchema` (id, created, updated), `Nullable()`, `NullableEnum()`. See any file in `src/lib/automation/` for examples.

## Key Utilities (`src/lib/core/common/`)

`apId()`, `isNil()`, `isEmpty()`, `tryCatch()`, `tryCatchSync()`, `spreadIfDefined()`, `spreadIfNotUndefined()`, `QadamFlowError({ code, params })`, `SeekPage<T>`, `formErrors`, `chunk()`, `partition()`, `unique()`, `omit()`, `deepMergeAndCast()`, `sanitizeObjectForPostgresql()`, `kebabCase()`, `camelCase()`, `debounce()`, `applyFunctionToValues()`

## Key Enums (where to ADD new entries)

- `Permission` (`src/lib/core/common/security/`) — 26 permissions. Add READ/WRITE pairs for new features.
- `ErrorCode` (`src/lib/core/common/qadam-flow-error.ts`) — 66 codes. Also add HTTP mapping in server's `error-handler.ts`.
- `ApFlagId` (`src/lib/core/flag/flag.ts`) — 42 feature flags.
- `FlowOperationType` — 26 flow modification ops. Add new op types here + handler in flow service.
- `FlowActionType` — CODE, PIECE, LOOP_ON_ITEMS, ROUTER.
- `FlowRunStatus` — 12 states (QUEUED, RUNNING, SUCCEEDED, FAILED, PAUSED, TIMEOUT, CANCELED, etc.).
- `BranchOperator` — 24 condition operators for router.
- `WorkerJobType` — 9 job types. Add new jobs here + handler in worker.
- `ApplicationEventName` — 19 audit events. Add for new auditable actions.

## Export Rules

Export from feature barrel → re-export from `src/index.ts`.

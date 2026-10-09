# @aiqadam/shared

Types, DTOs, Zod schemas, utilities. Every change under `src/`, or to a dependency section of this
`package.json`, adds a changeset naming this package and its level (CI's gate 1 reads exactly that
scope; a README, a test or an `AGENTS.md` edit needs none) — the level is the `versioning` skill's
call, the rule is [`.agents/rules/versioning.md`](../../.agents/rules/versioning.md); only the
release PR raises the version. It is private since #799: `qadams-framework` vendors all of its build at publish and
re-exports from it, so no `shared` version is published again — and such a change also needs a
changeset naming `@aiqadam/qadams-framework`, at the level the change has for a qadam author (gate 1
enforces it; the `versioning` skill says how to choose).

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

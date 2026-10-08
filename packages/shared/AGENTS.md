# @aiqadam/shared

Types, DTOs, Zod schemas, utilities. Every change bumps this package's own version, by hand, until
changesets land (#796) — the level is the `versioning` skill's call, the rule is
[`.agents/rules/versioning.md`](../../.agents/rules/versioning.md). It is still published and pinned
exactly by every published qadam until #799 makes it private.

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

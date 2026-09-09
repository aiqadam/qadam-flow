# Inline Subflows (callFlow `executionMode: "inline"`)

## Summary

An opt-in execution mode for the `callFlow` action (`@aiqadam/qadam-subflows`) that runs a child flow in-process within the parent engine process, bypassing BullMQ dispatch, parent pause/snapshot, and webhook callback round-trip. Default behaviour is unchanged — existing flows continue using the queue-based async path. The feature targets operators with chains of sequential lightweight children where ~12s per-hop overhead dominates actual work. Measured on a production `checkin-api` instance: 5 sequential hops totalled 16.4 s (4.2 s real work + ~12 s dispatch overhead).

## Architecture Decisions

### Why write a child run record?

Skipping the DB record entirely would reduce overhead to zero but destroys debuggability — no trace IDs, no step-level visibility, no `parentRunId` chaining in the UI, no `getAllChildRuns()` recursive CTE. Writing a FlowRun row inline (lightweight INSERT) without going through BullMQ or uploading logs to S3 preserves all observability at the cost of ~2ms per hop instead of ~2.4s.

### No new entities

No database schema changes needed. `FlowRunEntity` already has `parentRunId`, `failParentOnFailure`, `logsFileId`, and `environment`. All fields used by inline mode already exist.

### Depth guard

`FlowExecutor.execute()` uses an iterative `while(true)` loop — stack overflow is impossible. However, users can build infinite cycles via manual graph loops. A hard limit of 50 on nested inline depth protects against this. Tracked in `EngineConstants.inlineDepth` and incremented per inline invocation.

### Timeouts

Inline children count against the parent's `FLOW_TIMEOUT_SECONDS`. There is no separate timeout budget — adding one would complicate the interface for zero practical benefit. The operator controls this via step-level settings (`continue-on-failure`, retry logic encoded inside the child flow).

### Error semantics

Inline child failure → step throws → parent step fails → caught by `continue-on-failure` if set. No built-in retry (BullMQ policy doesn't apply). `{ status: 'success', data }` / `{ status: 'error', data }` preserved from the resume path.

### Sandbox/connections

Child executes in the **same engine process** as the parent — identical sandbox, connection resolver, env vars, loaded pieces, `AP_NETWORK_MODE=STRICT`. `StoreScope.FLOW` keys are scoped to child `runId` — no collisions. No security surface added.

## Key Files

- `packages/qadams/core/subflows/src/lib/actions/call-flow.ts` — action props (new `executionMode`), execute branch for `"inline"` mode
- `packages/server/engine/src/lib/handler/context/engine-constants.ts` — add `inlineDepth: number` property
- `packages/server/engine/src/lib/operations/flow.operation.ts` — new helper `executeInlineFlow()` or extend with inline flag
- `packages/server/api/src/app/flows/flow-run/flow-run-service.ts` — expose `startWithoutQueue()` method (create FlowRun row + persist metadata only, no BullMQ enqueue)
- `packages/shared/src/lib/automation/engine/engine-operation.ts` — `BaseExecuteFlowOperation` gains `inline?: boolean` (or pass via additional context)
- `packages/web/public/locales/en/translation.json` — i18n key for `"Execution Mode"` dropdown label
- `packages/server/api/test/integration/ce/flows/flow-run/execute-flow-e2e.test.ts` — E2E test: parent → inline callFlow → returnResponse, verify {status,data} and child run record exists

## Execution Flows

### Queue path (existing — unchanged)

```
Parent callFlow (BEGIN)
  ├─ createWaitpoint() → POST /v1/waitpoints        [DB write]
  ├─ waitForWaitpoint() → hookResponse = 'paused'    [pause signal]
  └─ HTTP POST webhook/{flowId} { callbackUrl }      [network hop]
       │
       ▼  [worker picks up EXECUTE_WEBHOOK → EXECUTE_FLOW]
Child run (sandbox, own process, DB record + S3 logs)
       │
       ▼  returnResponse → POST callbackUrl
       │
       ▼  [waitpoint resume → enqueue RESUME job → replay from logs]
Parent callFlow (RESUME) → reads context.resumePayload.body
```

### Inline path (new)

```
Parent callFlow (BEGIN)
  ├─ executionMode === "inline" + waitForResponse === true
  ├─ Create FlowRun row inline (INSERT, parentRunId, failParentOnFailure)
  ├─ Resolve child flow version from cloud storage
  ├─ ExecuteFlowOperation.inline = true → executeInlineFlow()
  │   ├─ trigger starts callableFlow (onStart: store callbackUrl under callableFlow_{childRunId})
  │   ├─ child walks its graph in memory (no sandbox provision, no JSON parse/upload/download)
  │   └─ returnResponse → POST callbackUrl (waitpoint resume URL)
  │       └─ waitpoint completes → resumePayload set (sync engine response watcher, no queue)
  ├─ callFlow sees RESUME → returns { status, data }
  └─ parent continues next step (no snapshot, no S3 upload, no download)
```

### Inline without waitForResponse

```
Parent callFlow (BEGIN)
  ├─ executionMode === "inline" + waitForResponse === false
  ├─ Create FlowRun row inline (INSERT, parentRunId)
  ├─ executeInlineFlow()
  │   ├─ trigger starts
  │   └─ child runs to completion asynchronously inside same process
  └─ returns immediately (child may still be running when parent moves on)
```

## Domain Terms

- **Inline subflow**: Child flow executing synchronously in the parent's engine process, without BullMQ dispatch, parent pause, or per-hop snapshot
- **Queue subflow**: Traditional path — child dispatched as a separate worker job, parent paused via waitpoint, resumed on webhook callback
- **inlineDepth**: Counter tracking nested inline invocations; enforced against a hard limit (50)
- **child run record**: A `FlowRun` DB row with `parentRunId` set — created inline even for inline subflows, providing debuggability without queue/S3 overhead

## Entities (no changes required)

**FlowRun** (existing)
| Column | Type | Notes |
|---|---|---|
| id | string | BaseColumnSchemaPart |
| created | timestamp | BaseColumnSchemaPart |
| updated | timestamp | BaseColumnSchemaPart |
| projectId | string | ApIdSchema |
| parentRunId | string (nullable) | Already exists — populated by inline path |
| failParentOnFailure | boolean (default true) | Already exists — propagated from callFlow prop |
| environment | RunEnvironment | Already exists |
| logsFileId | string (nullable) | Not written for inline children (state lives in memory) |

No migration needed — all columns pre-existing.

## Props Schema (callFlow action)

```ts
executionMode: Property.StaticDropdown({
  displayName: 'Execution Mode',
  required: true,
  description: 'How to execute the child flow. "Queue" dispatches a separate worker job (original behavior). "Inline" runs the child in-process for significantly lower latency.',
  defaultValue: 'queue',
  options: [
    { label: 'Queue', value: 'queue' },
    { label: 'Inline', value: 'inline' },
  ],
}),
```

Default is `'queue'` — existing flows unaffected.

## Implementation Checklist

- [x] Add `executionMode` prop to `callFlow` action (`call-flow.ts`)
- [x] Expose `flowRunService.startForInline()` in API server (create FlowRun row without BullMQ enqueue)
- [x] Add `inline?: boolean` + `inlineDepth: number` to shared types / EngineConstants
- [x] Create `execute-inline.ts` worker job handler — same as EXECUTE_FLOW but skips S3 log upload/snapshot backup
- [x] Wire inline path in `callFlow.run()` when `executionMode === 'inline'` → POST `/v1/worker/flow-runs/run-inline`
- [x] Add depth guard (`inlineDepth > 50` → throw) with full propagation chain:
  - Service increments depth → Enqueue as EXECUTE_INLINE → Worker handles → reports via sendFlowResponse
  - Framework adds `context.run.inlineDepth` accessible from qadms
- [x] Register entity if any schema change (none required)
- [x] Update translation.json for new prop labels (both web + qadams)
- [x] Run `npm run lint-dev` — ✅ clean (0 errors)

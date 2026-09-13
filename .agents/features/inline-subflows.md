# Inline Subflows (callFlow `executionMode: "inline"`)

## Summary

An opt-in execution mode for the `callFlow` action (`@aiqadam/qadam-subflows`) that runs the
target "Callable Flow" **in the same engine process** as the parent, synchronously — no BullMQ
job, no sandbox re-provisioning, no waitpoint pause/snapshot/resume, no webhook callback round
trip. Default remains `"queue"`, the pre-existing async webhook + waitpoint path — existing flows
are unaffected. Targets chains of sequential lightweight `callFlow` hops, where per-hop dispatch
overhead (queue dispatch, new sandbox, pause/resume) dominates the children's actual work
(reported: ~12s overhead vs ~4.2s real work across 5 hops, see issue #363).

An earlier attempt at this feature (dispatching the child via a `websocket.to('*')` broadcast to
an unscoped `/v1/worker/flow-runs/run-inline` HTTP endpoint) was dropped before merge: it did not
compile, the broadcast reached zero worker sockets so every call silently timed out and reported a
**fabricated success with no child execution**, the depth guard never received a real value so it
was unreachable, and the endpoint had no project-scoping check so an engine-token holder could
execute an arbitrary flow in another project. None of that design survives in this version — see
"Trust boundary" below for how each of those failure classes is closed here.

## Architecture Decisions

### Why in-process, not a faster queue path?

A `/sync`-webhook-reuse design (skip the waitpoint/callback round trip but still dispatch the
child as a normal `EXECUTE_FLOW` job) was considered and rejected as the *primary* design once the
user asked for the literal same-process behavior from the issue. It remains a safer fallback if
this design's latency win doesn't hold up under the benchmark (see the PR's benchmark section).

### Trust boundary: who resolves the target flow?

The engine process (running the parent's, and therefore semi-trusted, piece code) never resolves
or executes anything by itself. `context.run.callFlowInline({ flowId, payload })` is a thin RPC to
the **worker**, over the existing engine↔worker socket (`WorkerContract`, the same channel
`sendFlowResponse`/`uploadRunLog` already use) — see
`packages/server/engine/src/lib/handler/inline-flow-executor.ts`.

The worker, in turn, calls a new worker→API RPC, `startInlineFlowRun`
(`packages/server/api/src/app/workers/rpc/inline-flow-run.service.ts`), passing the **worker's own
trusted current-job context** (`callerProjectId`, `callerPlatformId`, `parentRunId`, `environment`
— captured from `ExecuteFlowJobData` at the top of `execute-flow.ts`, never anything the engine
supplied) alongside the caller-chosen `flowId`. The API handler:

1. Resolves the flow scoped by that trusted `callerProjectId` (`flowService.getOneOrThrow({ id,
   projectId })`) — a flow in another project simply isn't found, closing the gap the dropped
   design had.
2. Rejects if the flow is disabled, or its trigger isn't `@aiqadam/qadam-subflows`'s
   `callableFlow` (a crafted flow JSON could otherwise target a non-callable trigger).
3. Computes nesting depth via a recursive `parentRunId` ancestry query (see "Depth guard" below)
   and rejects past `INLINE_SUBFLOW_DEPTH_LIMIT` (50).
4. Creates the child `FlowRun` row (`parentRunId` set, `failParentOnFailure: true`) and fires the
   same `flowRunSideEffects.onStart` audit event any other run gets.

Only *after* that succeeds does the worker provision the child's pieces onto **the same sandbox
filesystem already in use** (`provisionFlowPieces`, reused as-is from `flow-helpers.ts`) and hand
the resolved `FlowVersion` back to the engine, which runs it in-process.

### Depth guard

`inlineDepth` is never carried through the engine/sandbox process — it's computed **server-side**
from the `parentRunId` ancestry chain (`WITH RECURSIVE ... WHERE a.depth < limit+1`), so a
compromised or buggy sandboxed piece cannot reset or omit it to bypass the limit. This is a
deliberate change from the original design questions, which assumed a client-carried depth
counter.

### Why in-process execution doesn't need a new sandbox

`qadamLoader.loadQadamOrThrow` already resolves and `import()`s a piece from disk lazily, at the
moment a step needs it — it isn't tied to "the one flow this sandbox process started for". And
`flowExecutor.executeFromTrigger()` is a pure function of `{ executionState, constants, input }`.
So `inline-flow-executor.ts` builds a **second, nested** `EngineConstants` (own `flowRunId`, own
`logsFileId`, `isInlineChild: true`, `inlineDepth: parent + 1`) and calls the very same
`flowExecutor.executeFromTrigger()` recursively, inside the parent's own call stack — no new
process, no new `sandbox.execute()` IPC round trip.

### Timeout: free, by construction

Because the child runs inside the SAME `sandbox.execute(EXECUTE_FLOW, ..., { timeoutInSeconds })`
call the parent is already inside, there is no separate timeout budget to wire up — if the parent
plus all nested children together exceed `FLOW_TIMEOUT_SECONDS`, the existing outer deadline that
already governs the whole IPC call fires and tears down the process, same as it would for a slow
parent flow with no `callFlow` at all.

### Progress reporting: children don't share the parent's global reporter state

`flowRunProgressReporter` tracks exactly one "current" flow via module-level state
(`latestUpdateParams`), because until now exactly one flow ever executed per engine process.
`EngineConstants.isInlineChild` makes `sendUpdate` a no-op for the child (guarded in
`flow-run-progress-reporter.ts`) — without this, a child's step updates would overwrite the
parent's `latestUpdateParams`, and a periodic/`backup()` flush could write the child's steps into
the *parent's* log file. Instead, `inline-flow-executor.ts` does its own, self-contained log
snapshot + `uploadRunLog` call once the child finishes — full step history is still preserved for
the child's `FlowRun`, it just isn't streamed live (`streamStepProgress: WEBSOCKET` test-mode
streaming does not apply to nested inline children in this version).

### Response semantics

`returnResponse` (`respond.ts`) already POSTs to a stored `callbackUrl` for the queue path. When no
`callbackUrl` was stored (inline path, or a flow hit directly via `/v1/webhooks/:flowId/sync`), it
now calls `context.run.stop({ response: { status: 200, body: { status: 'success', data } } })` —
the existing SDK primitive for "stop the flow and hand back a response synchronously". This sets
`FlowExecutorContext.verdict.stopResponse`, which `inline-flow-executor.ts` reads directly (no RPC,
no pubsub — the whole exchange is one recursive function call). Previously, calling this action
with no callback stored did nothing observable; this is a stated correctness fix that also happens
to be the inline path's only new piece of response plumbing.

### Unsupported: children that pause

A flow that pauses mid-execution (Delay, Human Input/Approval, or its own nested Queue-mode
`callFlow`) has no queue job to resume from when run inline. `inline-flow-executor.ts` detects
`FlowRunStatus.PAUSED` on the child's verdict and throws a clear, user-facing error telling the
author to use Queue mode for that subflow instead — this is an explicit scope limit, not a bug.

### Error semantics

Child `FlowRunStatus.FAILED` → `{ status: 'error', data: <failed step message> }`, surfaced to the
parent's `callFlow` step exactly like the existing RESUME branch already does (`throw new
Error(JSON.stringify(data))` when `waitForResponse` is set) — no new error-handling code path.

## Key Files

- `packages/qadams/core/subflows/src/lib/actions/call-flow.ts` — `executionMode` prop
  (`queue`|`inline`, default `queue`); inline branch calls `context.run.callFlowInline`
- `packages/qadams/core/subflows/src/lib/actions/respond.ts` — `context.run.stop()` when no
  callback URL was stored
- `packages/qadams/framework/src/lib/context/index.ts` — `CallFlowInlineHook` on `RunContext`
- `packages/server/engine/src/lib/handler/inline-flow-executor.ts` — the recursive execution
- `packages/server/engine/src/lib/handler/qadam-executor.ts` — wires the hook into `ActionContext`
- `packages/server/engine/src/lib/handler/context/engine-constants.ts` — `isInlineChild`,
  `inlineDepth`
- `packages/server/engine/src/lib/helper/flow-run-progress-reporter.ts` — inline-child guard
- `packages/server/worker/src/lib/execute/sandbox-manager.ts` — `InlineJobContext` (mutable,
  updated per `acquire()`, read fresh by the RPC handler — sandboxes can be reused across jobs)
- `packages/server/worker/src/lib/execute/create-sandbox-for-job.ts` — `resolveInlineFlow`
  `WorkerContract` handler: calls the API, then provisions child pieces locally
- `packages/server/worker/src/lib/execute/jobs/execute-flow.ts` — passes the trusted job context
  into `sandboxManager.acquire()`
- `packages/server/api/src/app/workers/rpc/inline-flow-run.service.ts` — project-scoped resolve +
  depth-guard + child `FlowRun` creation
- `packages/server/api/src/app/workers/rpc/worker-rpc-service.ts` — wires `startInlineFlowRun`
- `packages/shared/src/lib/automation/engine/requests.ts` — `ResolveInlineFlowRequest/Result`,
  `INLINE_SUBFLOW_DEPTH_LIMIT`
- `packages/shared/src/lib/automation/workers/worker-contract.ts` — `StartInlineFlowRunRequest/Result`

## Execution Flow (inline path)

```
Parent callFlow (executionMode: "inline")
  └─ context.run.callFlowInline({ flowId, payload })          [engine, same process]
       └─ workerClient.resolveInlineFlow({ flowId, payload })  [engine → worker, local socket]
            └─ apiClient.startInlineFlowRun({ callerProjectId (trusted), ... })
                 ├─ flowService.getOneOrThrow({ id: flowId, projectId: callerProjectId })
                 ├─ verify callableFlow trigger, verify ENABLED
                 ├─ depth = ancestor-chain(parentRunId) + 1;  reject if > 50
                 └─ create child FlowRun (parentRunId set) → { flowVersion, childRunId, childLogsFileId }
            └─ provisionFlowPieces(childFlowVersion)          [same sandbox filesystem]
       └─ nested EngineConstants (isInlineChild, own flowRunId/logsFileId)
       └─ flowExecutor.executeFromTrigger(...)                [recursive, same call stack]
            └─ returnResponse → context.run.stop({response})  [no callback needed]
       └─ finalize: log snapshot + uploadRunLog(childRunId)   [child FlowRun row now terminal]
  └─ returns { status, data } synchronously to the parent's callFlow step
```

## Props Schema (callFlow action)

```ts
executionMode: Property.StaticDropdown({
  displayName: 'Execution Mode',
  required: true,
  defaultValue: 'queue',
  options: { options: [
    { label: 'Queue', value: 'queue' },
    { label: 'Inline', value: 'inline' },
  ] },
}),
```

## Entities (no changes required)

No new entity, no migration. `FlowRunEntity.parentRunId` / `failParentOnFailure` already exist and
are populated the same way `queueOrCreateInstantly` populates them for the queue path.

## Domain Terms

- **Inline subflow**: A `callFlow` target executed synchronously, in the parent's own engine
  process, via a recursive `flowExecutor` call — no queue job, no waitpoint.
- **Queue subflow**: The pre-existing path — child dispatched as a worker job, parent paused on a
  waitpoint, resumed by an HTTP callback.
- **Inline job context**: The worker's own trusted `{projectId, platformId, parentRunId,
  environment}` for the job currently occupying a sandbox slot — the only source `resolveInlineFlow`
  may use to scope a target; never derived from anything the engine/sandbox supplies.

## Known Limitations (v1)

- A child that pauses (Delay / Human Input / its own Queue-mode `callFlow`) is rejected with a
  clear error, not supported. Since #391, `ap_validate_flow` also walks the inline call graph
  (transitively, cycle-safe, project-scoped) at validate time and reports this *before* publish
  rather than only at run time — see `validateCallFlowSteps` in
  `packages/server/api/src/app/mcp/tools/ap-validate-flow.ts`. The static check reads the callee's
  **draft** version, because it exists to judge what the author is about to publish; the runtime
  check in `inline-flow-executor.ts` remains the authority for what actually executes, and neither
  replaces the other. Its known limit: the pausing actions it recognises are an **allowlist**
  (`ALWAYS_PAUSING_ACTIONS`, plus the conditional `delayFor` and assemblyai `transcribe` cases),
  derived by grepping every qadam for `waitForWaitpoint`. A qadam added later that pauses will
  validate green and still fail at run time. Making this exhaustive needs a declared marker on the
  action rather than a table — tracked in #426, together with the narrower gap that the conditional
  cases (`wait_until_ready`, `waitForResponse`) are read as literals and so miss a value bound to a
  template expression.
- No live step-by-step streaming for an inline child in "Test Flow" mode — only the parent's own
  steps stream live; the child's full step history is still persisted and visible once it finishes.
- Narrow race: the child `FlowRun` row is created by the API (`inlineFlowRunService.start`) before
  the RPC response carrying its id travels back to the worker/engine. If that specific response is
  lost in transit (socket drop) after the DB write already committed, the engine never learns the
  child's run id and can't finalize it — the row is left `RUNNING` permanently, and nothing in the
  codebase currently reaps a stuck run. Closing this fully needs an idempotent/retryable RPC or a
  periodic reconciliation sweep for runs stuck `RUNNING`; deferred as a follow-up rather than
  blocking this feature, since it requires a transport failure in a specific narrow window, not any
  ordinary flow-author error (both those paths — provisioning failure, an unexpected engine throw —
  are covered).

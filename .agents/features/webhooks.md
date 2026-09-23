# Webhooks Module

## Summary
Ingests inbound HTTP requests from external services and routes them to flows for execution. The module normalizes request payloads (handling multipart, binary, JSON, and text), supports both synchronous (blocking, waits for flow response) and asynchronous (fire-and-forget) execution modes, manages handshake verification for external services that challenge webhook ownership, and enforces payload size limits. It is the primary entry point for event-driven flow execution from outside Qadam Flow.

## Key Files
- `packages/server/api/src/app/webhooks/webhook.service.ts` — core routing, sync/async execution, flow resolution
- `packages/server/api/src/app/webhooks/webhook-controller.ts` — 5 route registrations (sync, async, draft sync, draft async, test)
- `packages/server/api/src/app/webhooks/webhook-request-converter.ts` — payload normalization and file upload
- `packages/server/api/src/app/webhooks/webhook-handshake.ts` — handshake verification logic
- `packages/server/api/src/app/webhooks/webhook-backpressure-service.ts` — submit-time capacity check for sync webhooks (#510)
- `packages/server/api/src/app/webhooks/webhook-module.ts` — module registration
- `packages/shared/src/lib/automation/webhook/dto.ts` — WebhookUrlParams schema
- `packages/shared/src/lib/automation/trigger/index.ts` — WebhookHandshakeStrategy enum and WebhookHandshakeConfiguration schema
- `packages/web/src/app/builder/test-step/custom-test-step/test-webhook-dialog.tsx` — dialog for sending a manual test request to the webhook URL
- `packages/web/src/app/builder/test-step/test-trigger-section/manual-webhook-test-button.tsx` — button that opens the test webhook dialog
- `packages/web/src/app/builder/test-step/test-trigger-section/index.tsx` — test trigger panel (includes webhook test entry point)
- `packages/components/icons/webhook.tsx` — webhook icon used across the UI

## Domain Terms
- **Sync webhook** (`/:flowId/sync`) — blocks the HTTP connection until the flow completes and returns the flow's response payload
- **Async webhook** (`/:flowId`) — queues execution and returns 200 immediately with an `x-webhook-id` header
- **Draft webhook** — routes to the latest (draft) flow version instead of the published version; used for testing
- **Test endpoint** (`/:flowId/test`) — captures the request as sample data without executing the flow
- **Handshake** — a one-time ownership challenge sent by external services before activating a webhook subscription
- **HandshakeStrategy** — how ownership is verified: `HEADER_PRESENT`, `QUERY_PRESENT`, `BODY_PARAM_PRESENT`, `NONE`
- **engineResponseWatcher** — a one-time listener that bridges the BullMQ engine response back to the waiting HTTP connection for sync mode
- **LOCKED_FALL_BACK_TO_LATEST** — version resolution: uses `publishedVersionId` if set, falls back to latest draft
- **flowExecutionCache** — Redis-backed fast path for resolving flow metadata without hitting PostgreSQL on every webhook

## Routes (5 endpoints, all public)

| Route | Mode | Version | Purpose |
|-------|------|---------|---------|
| `/:flowId/sync` | SYNC | LOCKED_FALL_BACK_TO_LATEST | Production sync — blocks HTTP, returns flow response |
| `/:flowId` | ASYNC | LOCKED_FALL_BACK_TO_LATEST | Production async — queues job, returns 200 immediately |
| `/:flowId/draft/sync` | SYNC | LATEST | Testing sync — always uses draft version |
| `/:flowId/draft` | ASYNC | LATEST | Testing async — draft version |
| `/:flowId/test` | ASYNC | LATEST | Sample data only — no execution |

All routes accept GET, POST, PUT, DELETE, PATCH methods.

## Sync vs Async Execution

**Async path**:
1. Offload payload to S3/DB if > `AP_WEBHOOK_PAYLOAD_INLINE_THRESHOLD_KB` (default 512KB). The job carries a `JobPayload` discriminated union — `inline` (value embedded) or `ref` (`fileId` of a `WEBHOOK_PAYLOAD` file).
2. Queue BullMQ job (`WorkerJobType.EXECUTE_WEBHOOK`)
3. Return 200 with `x-webhook-id` header immediately

The worker forwards the `JobPayload` straight into the `EXECUTE_TRIGGER_HOOK` engine operation; the **engine** resolves it at execution time (inline value, or a `ref` downloaded via the file-download path — direct bytes or an S3 signed-link redirect). Workers no longer fetch payloads themselves.

**Sync path**:
1. Create FlowRun with `ProgressUpdateType.WEBHOOK_RESPONSE`
2. Register one-time listener via `engineResponseWatcher`
3. Wait for engine to send response (default timeout: `AP_WEBHOOK_TIMEOUT_SECONDS`, default 30; callers may pass `timeoutMs` to override per-invocation, e.g. MCP uses 5 minutes)
4. Return the flow's response (status, body, headers). With no Return Response step the engine answers itself: 204 on SUCCEEDED, a generic 500 on any other terminal status (`flow.operation.ts`, plus `execute-flow.ts` for failures the engine never reports). A run still going at the timeout gets `SYNC_RUN_TIMEOUT_RESPONSE`: 504, no `Retry-After`, no `runId` (the legacy resume route takes the run id alone as its credential)

### Dispatch deadline, backpressure, and dispatch-wait observability (#510)

- **`syncDeadline`** — `handleSync` computes `Date.now() + (timeoutMs ?? WEBHOOK_TIMEOUT_MS)` (the exact instant the sync listener's own timeout fires) and threads it through `flowRunService.start` → `addToQueue` as `ExecuteFlowJobData.syncDeadline` (optional, set only on a sync webhook's initial `BEGIN` dispatch — never on retry, async webhook, or manual trigger). `/:flowId/draft/sync` and MCP's `returnsResponse` path both go through `handleSync` too, so there is no test/draft exemption from this deadline. `executeFlowJob.execute` (worker) checks it before any other work, gated to the job's first delivery only (`ctx.attemptsStarted === 0`, from BullMQ's own `Job.attemptsMade`) so a mid-execution throw or a stalled-job re-delivery — which carries the same, now-expired `syncDeadline` — is never wrongly marked FAILED over a run's real outcome: if the wall clock is already past the deadline on that first delivery, the run is failed explicitly (`FlowRunStatus.FAILED`, with an `internalError` from `RunInternalErrorSource.WORKER` recording that the dispatch deadline was exceeded) instead of executing for a caller that has already been answered the 504. The job itself completes with `EngineResponseStatus.OK`, not an error status — a deadline miss is a handled outcome, not something that should burn a second BullMQ attempt. A run whose deadline has not yet passed by dequeue time is unaffected even if it later runs long — only the "has not started yet" moment is gated. This is a plain wall-clock comparison between whichever server stamped `syncDeadline` and whichever worker later reads it, so it assumes synchronized clocks (NTP) across servers; it is not "safe by construction" independent of that assumption.
- **Backpressure** (`webhook-backpressure-service.ts`) — before creating a run, a sync webhook call checks `checkCapacity()`: worker slot count (`AP_WORKER_CONCURRENCY` summed across the online worker registry, `workerMachineCache`) versus the shared BullMQ queue's `waiting`/`active` counts. Refuses upfront with `503` + `Retry-After: AP_SYNC_WEBHOOK_BACKPRESSURE_RETRY_AFTER_SECONDS` only when every slot is busy **and** a full extra round of runs is already queued behind them (`active >= slots && waiting >= slots`) — the earliest point "will not start in time" can be said without guessing a per-run duration. A registry read of zero slots (no worker has ever connected, e.g. most non-e2e test suites) is treated as unknown capacity, not zero, and never blocks. Toggle with `AP_SYNC_WEBHOOK_BACKPRESSURE_ENABLED`. The check is **instance-wide**, not per-project or per-platform: `QueueName.WORKER_JOBS` (`job-queue.ts#getQueueName()`) is the same single shared BullMQ queue regardless of which project or platform a run belongs to, so one busy project/platform can cause another's sync webhooks to be refused.
- **`dispatchWaitMs`** — derived (never persisted) on `FlowRun`, computed at read time in `flowRunService` as `startTime - created`. `null` until the run starts. INLINE dispatch mode reads `0` by construction (synchronous with row creation); a `FROM_FAILED_STEP` retry resets `startTime` on the same row, so the field then measures elapsed time since the run's original creation, not the latest retry's own queue wait — see the comment on `withDispatchWaitMs` for the full reasoning. No DB migration: purely a read-path computation.

## Request Conversion

`webhookRequestConverter.convertRequest()` normalizes incoming data:
- **Multipart form-data**: Uploads files to File service, returns URLs in JSON
- **Binary content** (image/*, video/*, audio/*, pdf, zip, gzip, octet-stream): Uploads to File service
- **JSON/text**: Passes through as-is
- Preserves `rawBody` for signature verification (non-binary only)
- `extractHeaderFromRequest()` (in `webhook-request-converter.ts`) copies `ap-parent-run-id` / `ap-fail-parent-on-failure` into the run request unchecked, and additionally derives a `parentWaitpointId` from the request *body*'s `callbackUrl` field (not a header — see below). Every one of these is caller-controlled, so none is trusted here. Two independent checks apply downstream, both in `#521`'s scope:
  - **`parentRunId` itself** is verified in `flowRunService`'s `queueOrCreateInstantly` (`resolveVerifiedParent`/`findParentRun`, shared with the inline-subflow depth guard): kept only if it belongs to the webhook flow's own project (a persisted `flow_run` row, or a `pending_run_owner:<id>` Redis entry for a PRODUCTION parent whose row hasn't flushed yet — see `flow-runs.md`'s #509 note); otherwise dropped and the run still starts, unparented. This is the single choke point for both the sync path (`webhook.service.ts#handleSync` → `flowRunService.start`) and the async path (job data → worker `execute-webhook.ts` → `submitPayloads` → `start`).
  - **`failParentOnFailure`** additionally requires proof, checked once in `webhook.service.ts#resolveParentAttachment` before branching into sync/async: same-project ownership of `parentRunId` alone isn't enough, because anyone who can call this project's own webhooks can name any run id in it, and a failing child would otherwise complete and resume a stranger's paused run (impact item 3, still open after `parentRunId`'s own project check). The proof is `parentWaitpointId`, extracted from the request body's `callbackUrl` field (every call-flow release already sends `body: { data, callbackUrl }`, where `callbackUrl` is the `/v1/flow-runs/<flowRunId>/waitpoints/<waitpointId>[/sync]` URL `waitpoint-controller.ts` handed back when the waitpoint was created) rather than a dedicated header — a new header would need a qadam version bump before any already-published call-flow step could ever send it, silently stranding every already-deployed flow's parent PAUSED indefinitely (a WEBHOOK waitpoint has no `AP_PAUSED_FLOW_TIMEOUT_DAYS`-style cap; that cap only applies to DELAY waitpoints). The extracted `callbackUrl`'s own `flowRunId` must equal `parentRunId`, and the extracted waitpoint id must name a PENDING `WEBHOOK` waitpoint owned by that exact `parentRunId` in this project (`waitpointService.existsPendingWebhookWaitpoint`). This proof is exactly as strong as the `callbackUrl` capability itself, no stronger: whoever holds that URL could already resume the parent directly (with or without an error), so accepting it here grants nothing beyond what its holder can already do — it is not a claim that the id "reaches nobody but this call." Missing or mismatched proof silently drops `failParentOnFailure` (not `parentRunId`); the run still starts. Once verified, the exact id is persisted on the child as `flow_run.parentWaitpointId`, so a later failure completes only that one waitpoint via `waitpointService.complete()` (a no-op if it's no longer the PENDING row) rather than whichever waitpoint the parent happens to hold at that later moment — see `flow-runs.md`'s `parentWaitpointId` note. A child predating this column (`failParentOnFailure: true`, no stored `parentWaitpointId`) completes nothing on failure and logs a warning; its parent is stranded PAUSED until manually retried or cancelled — a narrow, one-time migration-window trade-off, since falling back to "whatever waitpoint the parent currently holds" would reopen the exact vulnerability this closes. `resolveVerifiedParent` re-runs `existsPendingWebhookWaitpoint` itself (not just at webhook ingress) before ever persisting `parentWaitpointId`: `submitPayloads` is a WORKER-authenticated RPC method callable directly, not only as the tail of the webhook job `execute-webhook.ts` builds, so a `parentWaitpointId` reaching `start()` has not necessarily passed `resolveParentAttachment`'s check at all — without the re-check, an unverified id would still be persisted and later handed to `waitpointService.complete()` as-is, which matches on id + PENDING status only, not on waitpoint *type*, so it could complete some other PENDING waitpoint on the same (verified) parent, e.g. a DELAY or an unrelated approval step (#521).

## Handshake Verification

External services verify webhook ownership before sending events:
- **HEADER_PRESENT**: Check for specific header
- **QUERY_PRESENT**: Check for query parameter
- **BODY_PARAM_PRESENT**: Check for body field
- Submits HANDSHAKE hook job to worker → piece validates signature → returns verification response

## Payload Size Limit

`AP_MAX_WEBHOOK_PAYLOAD_SIZE_MB` (default 25MB). Returns 413 if exceeded.

## Flow Resolution

- Uses `flowExecutionCache` for fast lookup
- LOCKED_FALL_BACK_TO_LATEST: uses `publishedVersionId` if exists, else latest
- Returns 410 GONE if flow not found, 404 if disabled

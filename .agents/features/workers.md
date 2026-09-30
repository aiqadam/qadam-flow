# Workers Module

## Summary
Workers are separate Node processes that poll the app for jobs and execute flows/triggers in sandboxes. They connect to the app over a Socket.IO channel: on connect a worker fetches its runtime settings (`WorkerSettingsResponse`) and the app registers an RPC server (`WorkerToApiContract`) for that socket. Jobs are pulled by the worker via `poll()` rather than pushed. A worker advertises liveness and config through `MachineInformation` (heartbeat), whose `workerProps` carry its identity including `version`. In the Docker image `AP_CONTAINER_TYPE` (`APP` or `WORKER`, required — there is no default and `WORKER_AND_APP` was removed) selects which process starts from `WORKDIR /usr/src/app`; `docker-entrypoint.sh` `exec`s Node directly, so a crash exits the container instead of being restarted in place.

## Key Files
- `packages/server/api/src/app/workers/machine/machine-controller.ts` — Socket.IO listeners (`FETCH_WORKER_SETTINGS`, `DISCONNECT`); registers the RPC server per connection
- `packages/server/api/src/app/workers/machine/machine-service.ts` — `onConnection` / `onDisconnect`, `buildSettingsResponse` (emits `APP_VERSION`), worker listing
- `packages/server/api/src/app/workers/rpc/worker-rpc-service.ts` — `createHandlers()`: `poll` (with version gate), `completeJob`, `extendLock`, progress/log RPCs
- `packages/server/worker/src/lib/worker.ts` — worker lifecycle (`worker.start/stop`), `pollAndExecute` loop (with version gate), `getWorkerProps`
- `packages/server/worker/src/lib/config/worker-settings.ts` — caches the `WorkerSettingsResponse` fetched on connect
- `packages/server/utils/src/ap-version.ts` — `apVersionUtil.getCurrentRelease()`; both sides read the deploy-root `package.json` version
- `packages/shared/src/lib/automation/workers/index.ts` — `WorkerProps`, `MachineInformation`, `WorkerSettingsResponse`, `WorkerToApiContract` contracts

## Domain Terms
- **`WorkerProps`** — typed worker identity sent in every heartbeat (`EXECUTION_MODE`, `WORKER_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `REUSE_SANDBOX`, `version`). Previously a free-form `Record<string,string>`.
- **`WorkerSettingsResponse`** — runtime config the app hands a worker on connect; now includes `APP_VERSION` (the app's release).
- **`connectionGeneration`** — worker-side counter bumped on every disconnect; in-flight poll loops exit when their captured generation goes stale, so a reconnect starts fresh loops.
- **version gate** — both sides refuse to exchange jobs when worker release ≠ app release (see below).

## Connection & Poll Flow
1. Worker connects → emits `FETCH_WORKER_SETTINGS`; app's `machineService.onConnection` returns `WorkerSettingsResponse` (incl. `APP_VERSION`) and registers `createHandlers` for the socket.
2. Worker caches settings and spawns `concurrency` `pollAndExecute` loops.
3. Each loop calls `apiClient.poll(machineInfo)`; the app's `poll` handler returns the next job for the worker's queue, or `null`.
4. On job: worker executes in a sandbox, periodically `extendLock`, then `completeJob`.
5. On disconnect, `connectionGeneration++` stops the loops; Socket.IO auto-reconnects and the cycle repeats.

**A poll belongs to its socket (#589).** The app's `poll` is a long-poll: `queue-dispatcher.ts` parks it as a waiter for up to `WAITER_TIMEOUT_MS` (50 s) and hands the next dequeued job to the oldest waiter. `machine-controller.ts` gives each socket's handlers an `AbortSignal` (`disconnected`) that aborts on the socket's `disconnect`, and `jobBroker.poll({ queueName, signal })` passes it to the dispatcher.
- On abort, the dispatcher drops that socket's waiters (they resolve `null`), so the next job goes to a live worker. A poll that arrives on an already-closed socket returns `null` at once, before the registry upsert, so it cannot re-register a worker that `onDisconnect` just removed.
- If a job was handed out in the same turn the socket closed, the `poll` handler returns it with `jobBroker.returnToQueue` (`moveToDelayed(now + 100 ms)`) instead of acking it. It logs `[workerRpc#poll] Worker disconnected while its poll was pending`.
- Before this, a worker restart left one waiter per slot behind. The next jobs went to them and were acked into the closed socket. They then sat active until the 120 s lock expired and the stalled check re-queued them, so they ran ~139 s late with `stalledCounter: 1`. A sync caller had already had its 504, and `syncDeadline` (#533) does not apply to a redelivery.
- Not covered: a half-open TCP connection that Socket.IO has not noticed yet (up to its ping timeout). Its jobs still go through the stalled path.

> **Payload resolution is engine-side, not worker-side.** Jobs carry a `JobPayload` (`inline` value or `ref` `fileId`). The worker forwards it unchanged into the engine operation; the engine hydrates a `ref` via the file-download path (direct bytes or an S3 signed-link redirect). There is no worker→API payload-fetch RPC — the contract exposes no `getPayloadFile`.

## Engine RPC Run Scope (#512)
The engine is untrusted; the worker is not. The run-scoped `WorkerContract` RPCs the engine makes
(`uploadRunLog`, `updateRunProgress`, `updateStepProgress`, `sendFlowResponse`) are checked in
`create-sandbox-for-job.ts` via `engineRunScope` (`execute/engine-run-scope.ts`) against the
`SandboxJobContext` the worker itself built from the dequeued job, before they reach the API:
- the run id must be the job's own run, or an inline child that job started through
  `resolveInlineFlow`; the project id must be the job's;
- `sendFlowResponse` must name the job's own `workerHandlerId` + `httpRequestId`, so an async job
  (both null) can answer no one;
- `resolveInlineFlow`'s `parentRunId` is held to the same run set, under the job's project, before
  `startInlineFlowRun` is called: every inline child fails its parent on failure, and the API only
  checks that the parent is in the caller's project, so a foreign same-project parent would let the
  engine fail and resume an unrelated paused run (#525). A nested inline call names its own inline
  parent, which the scope already recorded, so it still passes;
- no flow job in the sandbox (trigger, property, validation jobs) → every such RPC is refused
  (`resolveInlineFlow` answers `{ ok: false }` without calling the API, as it always did);
- a refusal throws `ErrorCode.AUTHORIZATION` back to the engine and is logged as a warning.

The runs-metadata drain (`flow-runs-queue.ts`) adds defence in depth for the row itself: it
matches a row on `id` **and** `projectId`, never writes `projectId`, drops an update whose run id
already exists under another project, and creates a pending row only for a flow in the project the
metadata names. It does not police the `runs_metadata:<id>` hash, which merges every write for a run
id regardless of project — the worker check above is what keeps foreign writes out of it.

## Cold Qadam-Import Log Line (#419 Phase 0)
The engine (`packages/server/engine/src/lib/helper/qadam-loader.ts`, `loadQadamOrThrow`) emits one
`console.log` line, prefixed `[qadamLoader] cold load `, the first time a resolved qadam dist path
is imported in a process — a repeat (warm) import of the same path logs nothing. Grep worker stdout
for the prefix to find these. JSON fields on the line:
- `qadam` — the requested `name@version` (what the flow step actually pinned).
- `resolvedVersion` — the version actually loaded, read from the resolved package's own
  `package.json`; can differ from `qadam`'s version when a stale pin falls through to a newer
  bundled dist (#503), and is `null` if that `package.json` couldn't be read. Never the resolved
  file path itself — an installed/ARCHIVE qadam's path can carry a platform- or tenant-specific
  segment, and this line must never leak one.
- `resolveMs` — time in `qadamLoader.getQadamPath` (path resolution).
- `importMs` — time in `await import(qadamPath)`.
- `sharedDepsAlreadyLoaded` — whether `@aiqadam/qadams-framework`'s dist entry was already in the
  CJS module cache before this import (an earlier qadam in the same process pulled it in already).
  Not exposed as a step-output field; log-only.
- No `executionMode` on the line by design (app-sec): engine stdout can reach a user-facing error
  context (`app-connection-service.ts:680-684`), and the worker already logs its execution mode at
  startup (the `Worker settings loaded` line in `worker.ts`).

## Cold Engine Slots (#419 Phase 1)
Engine processes are spawned lazily, so after every worker start (each deploy) the first job on
each of the `AP_WORKER_CONCURRENCY` slots used to pay the process start, the dist-index build (the
first `resolveMs`) and the framework's module graph (most of the first `importMs`). Three pieces
move that off the first job:
- **Dist-index manifest.** The Dockerfile runs `packages/server/engine/src/scripts/write-qadam-dist-index.ts packages/qadams`
  (the root is a required argument) after the qadam build, writing `packages/qadams/dist-index.json` (name, version, `dist/src/index.js`
  path relative to `packages/qadams`, in scan order); the build fails if it finds no built qadam,
  and the run stage checks the file survived the copy (`test -s`).
  `qadamDistIndex.get({ refresh: false })` (`engine/src/lib/helper/qadam-dist-index.ts`) reads it
  instead of walking the tree. A manifest that is unreadable, not version 1, empty, points outside
  `packages/qadams` or names a dist that is not on disk is rejected with a
  `[qadamDistIndex] manifest rejected, scanning instead {"reason":...}` line through the caller's
  `warn` sink (the warmup's unpatched console, or a job's own console when the job is first to build
  the index) and the scan runs; a missing one scans quietly. A `refresh` (dev-qadam lookup) always scans. The file is gitignored:
  never generate it in a dev tree, where it would go stale.
- **Prewarm.** On by default; `AP_WORKER_PREWARM_ENGINES=false` turns it off (each engine holds about
  100 MiB from boot). Only `true`/`false` parse (`asBoolStrict`): any other value throws inside the
  prewarm, which logs `Prewarm failed` and leaves the slot lazy. It runs on every (re)connect, since
  each connect starts a new set of poll loops. Each slot's poll loop calls `sandboxManager.prewarm()` before its first poll
  (`prewarmSlot` in `worker.ts`), so no job can race it. It is skipped when the loop would not poll
  (`loopWillPoll`, the same check the poll loop uses, or an API version mismatch) and raced against a
  stop request.
  Forked engines only: a reusable sandbox (`canReuseSandbox()`) that does not run in an isolate —
  `UNSANDBOXED`, `SANDBOX_CODE_ONLY`, and dev with either. It provisions the engine with no qadams
  and starts the sandbox with no platform and no flow version, logging
  `[sandboxManager#prewarm] Sandbox started before its first job` with `prewarmMs`. Best effort: any
  failure is a warning, the sandbox is dropped and the slot polls as before. A prewarm abandoned by a
  stop cannot leak an engine: every `invalidate`/`shutdown` bumps the manager's generation, so a
  prewarm that sees it changed starts no sandbox after the install, and shuts down (quietly, at
  debug) one that was already starting. That relies on the worker shutting down every manager it
  stops using; if managers ever outlive a reconnect (#585), re-check it. Isolate modes (`isIsolateMode`
  — `SANDBOX_PROCESS`, `SANDBOX_CODE_AND_PROCESS`) skip it even when reused, because their mounts are
  fixed at start and a prewarmed box would have none.
- **Engine warmup.** Only the sandbox a prewarm starts gets `AP_ENGINE_WARMUP=true` (`warmup: true` on
  `createSandboxForJob`). One a job starts, reusable or not, never does: its warmup would race that
  job and make the job's #548 `cold load` line report `sharedDepsAlreadyLoaded: true`. On
  its first connect, the engine (`engine/src/lib/helper/engine-warmup.ts`) builds the dist index and
  `require`s `@aiqadam/qadams-framework` and `@aiqadam/qadams-common` through a bundled qadam's
  directory, then writes `[engineWarmup] done {distIndexMs, qadams, sharedDepsMs, sharedDeps}` through
  the unpatched console: worker stdout, never a job's log. The first real qadam import then reports
  `sharedDepsAlreadyLoaded: true`. It never throws: a failure writes `[engineWarmup] failed {error, stack}`
  through the unpatched console's stderr, and only means the first job pays the cost itself.

## Job Timing and Event-Loop Lines (#587)
Three log lines answer "where did a slow job's time go" without OTEL. All of them are info or warn, so they reach journald on QA.

**`[worker] Job finished`** (worker, info) — written by `runPollLoop` (`worker.ts`) once per job after `completeJob`, whatever the outcome. Jobs that failed to parse are included.
- **Identity:** `jobId`, `jobType`, `flowId` (every job type that has one), `runId` (EXECUTE_FLOW only). These are read defensively from the raw payload.
- **Outcome:** `attemptsStarted` (0 on a genuine first delivery; see `ConsumeJobRequest`), `status` (the value sent to `completeJob`), and `completed` (whether `completeJob` itself succeeded).
- **Totals:** `durationMs` runs from the worker receiving the job to the `completeJob` reply; the API-to-worker hand-off is not in it. `completeMs` is the `completeJob` RPC alone.
- **Phases,** from `execute/job-timings.ts`, absent when the job never reached them:
  - `flowVersionMs` and `provisionMs`: each handler wraps its `flowCache.getVersion` call and its provisioning in `ctx.timings.measure`. The provisioning is `provisionFlowPieces`, or `provisioner().provision` for property, validation and extract jobs. It covers qadam install and code build.
  - `sandbox` (`cold` | `warm`) and `sandboxStartMs`: a job counts as cold if any sandbox it started had no live process.
  - `executeMs` and `executeCount`: summed over every `sandbox.execute`.

  The sandbox phases come from `jobTimings.instrumentSandboxManager`. It wraps the slot's manager for the job's lifetime, so no handler records them itself. Inline `callFlow` children provision inside the parent's `execute` and count toward `executeMs`.

**`[jobBroker#tryDequeue] Dequeued job`** (API, info) carries `queueWaitMs`, `plannedDelayMs`, `attemptsMade` and `stalledCounter`. Join it to the worker line on `jobId`. A job an interceptor sends back to delayed (e.g. the rate limiter) is dequeued, and logged, again on each pass, and each line's `queueWaitMs` includes the delays so far.
- `queueWaitMs` is `Date.now() - job.timestamp - job.opts.delay`: the time since the job first became runnable.
- `plannedDelayMs` is taken from `opts` because BullMQ zeroes the job's `delay` field when it promotes it. A scheduler or cron iteration is added with a delay of a whole interval, so without this subtraction every cron job would look like a backlog.
- On a retry the wait still spans every earlier attempt and its backoff. That is the 8-minute gap of #584.
- Measured on the API, so worker clock skew cannot enter it. The API replicas' clocks must still agree.

**`[eventLoopMonitor] Event loop was blocked`** (app and worker, warn). This is `eventLoopMonitor` from `@aiqadam/server-utils`, started in `setupApp` and in the worker's `main`.
- It samples `perf_hooks.monitorEventLoopDelay` every 10 s and writes only when the window's `maxLagMs` is ≥ 500 ms. It also reports `p99LagMs` and `meanLagMs`.
- Every value is net of the 20 ms sampling resolution, because the histogram records whole sample intervals.

`[workerRpc#poll] Poll request received` is **debug** since #587. Every slot long-polls continuously, so at info it was most of the app's log. A hand-out is still logged at info (`Returning job to worker`).

## Version Gating (rolling-deploy safety)
During a rolling upgrade the app and worker fleets briefly run different builds. Mixing them risks flow-schema/contract skew and silent run corruption, so dispatch is gated on an exact release match — both sides enforce it, whichever runs the newer build:
- **App side** (`worker-rpc-service.ts#poll`): if `input.workerProps.version !== apVersionUtil.getCurrentRelease()`, it logs a warning and returns `null` (withholds the job). An old worker can never receive jobs from a new app.
- **Worker side** (`worker.ts#pollAndExecute`): if the connected app's `APP_VERSION !== AP_VERSION`, it pauses polling (`VERSION_MISMATCH_POLL_PAUSE_MS`, 10s) and retries. A new worker won't pull from an old app.
- **Recovery** is automatic: once both fleets converge on the same release, polling resumes on the next cycle — no restart needed.
- **Version source**: `apVersionUtil.getCurrentRelease()` reads `process.cwd()/package.json`, which is the deploy-root release version (e.g. `0.83.0`) for both processes — not a workspace `package.json`. On read failure it falls back to `0.0.0` symmetrically, so a misconfigured-but-identical pair still matches.

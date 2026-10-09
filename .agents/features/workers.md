# Workers Module

## Summary
Workers are separate Node processes that poll the app for jobs and execute flows/triggers in sandboxes. They connect to the app over a Socket.IO channel: on connect a worker fetches its runtime settings (`WorkerSettingsResponse`) and the app registers an RPC server (`WorkerToApiContract`) for that socket. Jobs are pulled by the worker via `poll()` rather than pushed. A worker advertises liveness and config through `MachineInformation` (heartbeat), whose `workerProps` carry its identity including `version`. In the Docker image `AP_CONTAINER_TYPE` (`APP` or `WORKER`, required — there is no default and `WORKER_AND_APP` was removed) selects which process starts from `WORKDIR /usr/src/app`; `docker-entrypoint.sh` `exec`s Node directly, so a crash exits the container instead of being restarted in place.

## Key Files
- `packages/server/api/src/app/workers/machine/machine-controller.ts` — Socket.IO listeners (`FETCH_WORKER_SETTINGS`, `DISCONNECT`); registers the RPC server per connection
- `packages/server/api/src/app/workers/machine/machine-service.ts` — `onConnection` / `onDisconnect`, `buildSettingsResponse` (emits `APP_VERSION`), worker listing
- `packages/server/api/src/app/workers/rpc/worker-rpc-service.ts` — `createHandlers()`: `poll` (with version gate), `stopPolling`, `completeJob`, `extendLock`, progress/log RPCs
- `packages/server/worker/src/lib/worker.ts` — worker lifecycle (`worker.start/stop`), `pollAndExecute` loop (with version gate), `getWorkerProps`
- `packages/server/worker/src/lib/config/worker-settings.ts` — caches the `WorkerSettingsResponse` fetched on connect
- `packages/server/utils/src/ap-version.ts` — `apVersionUtil.getCurrentRelease()`; both sides read the deploy-root `package.json` version
- `packages/shared/src/lib/automation/workers/index.ts` — `WorkerProps`, `MachineInformation`, `WorkerSettingsResponse`, `WorkerToApiContract` contracts

## Domain Terms
- **`WorkerProps`** — typed worker identity sent in every heartbeat (`EXECUTION_MODE`, `WORKER_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `REUSE_SANDBOX`, `version`). Previously a free-form `Record<string,string>`.
- **`WorkerSettingsResponse`** — runtime config the app hands a worker on connect; now includes `APP_VERSION` (the app's release).
- **`connectionGeneration`** — worker-side counter bumped on every disconnect. A caller that captured it before an RPC can tell afterwards whether the call spanned a disconnect: the poll loop skips its back-off then, and `reconnectSafeApiClient` resends (#585). Loops no longer exit on it.
- **connection gate** — worker-side flag, open while the socket is connected and that connection's settings are loaded. Poll loops wait on it across a disconnect instead of exiting.
- **drain** — what `worker.stop()` does: stop polling at once (the API ends the parked polls), wait up to `AP_WORKER_SHUTDOWN_GRACE_SECONDS` (default 60) for in-flight jobs, then shut the sandboxes down.
- **lease** — a worker's hold on a job it was handed: the BullMQ lock (120 s, `WORKER_JOB_LOCK_DURATION_MS` in `@aiqadam/shared`, read by both `job-broker.ts` and the worker's `lease-tracker.ts`) under the job's `token`. The worker renews it every 30 s with `extendLock`; a lease is **lost** when the lock expired or passed to a redelivered copy.
- **given up** — an in-flight job that may no longer report completion: its lease was lost (`lease-lost`), or a stop's grace expired on it (`shutdown`). The `Job finished` line carries `givenUp`.
- **version gate** — both sides refuse to exchange jobs when worker release ≠ app release (see below).

## Connection & Poll Flow
1. Worker connects → emits `FETCH_WORKER_SETTINGS`; app's `machineService.onConnection` returns `WorkerSettingsResponse` (incl. `APP_VERSION`) and registers `createHandlers` for the socket.
2. Worker caches settings, opens the connection gate and, on the first connect only, spawns `concurrency` `pollAndExecute` loops, one per sandbox manager.
3. Each loop calls `apiClient.poll(machineInfo)`; the app's `poll` handler returns the next job for the worker's queue, or `null`.
4. On job: worker executes in a sandbox, renews the lease with `extendLock` every 30 s, then `completeJob`.
5. On disconnect, `connectionGeneration++` closes the gate. Socket.IO reconnects (the worker drives it by hand after `io server disconnect`), and the gate reopens.

## Reconnect and Drain (#585)
- **A reconnect keeps everything.** The loops, the sandbox managers and any running job survive it. Until #585, every connect shut all managers down and started fresh ones, which killed each engine that was mid-job; the run failed as `INTERNAL_ERROR` and waited out the 8-minute retry (#584).
  - A poll that was parked when the connection dropped fails at once (socket.io rejects pending acks with "socket has been disconnected"). The loop sees the generation change, skips the 25 s back-off, and waits on the gate.
  - A running job's RPCs go through `reconnectSafeApiClient` (`src/lib/reconnect-safe-api-client.ts`). It resends `completeJob`, `updateRunProgress`, `updateStepProgress`, `uploadRunLog` and `sendFlowResponse` when a disconnect happened while the call was in flight, up to 3 attempts. Every call, resent or new, waits (up to 60 s) for the connection gate rather than for socket.io's send buffer: the buffer is flushed on connect, before the API has answered the settings request that attaches its RPC handlers, so a buffered call is never acknowledged. Calls that create something (`startInlineFlowRun`, `submitPayloads`, …), `poll` and `extendLock` are never resent. The engine's own RPC to the worker still gives up after 60 s, so a run reporting progress through a longer outage fails anyway.
  - A resent `completeJob` is safe because `jobBroker.completeJob` acts only for the token that holds the job's lock: a duplicate (the first call already released it) or a completion from a worker whose lease was lost returns early, before any publish or interceptor. A completion that loses its lock between that check and `moveToCompleted` / `moveToFailed` (BullMQ's `Lock mismatch` / `Missing lock`) is logged at info and ignored the same way. A lock that cannot be read at all (a Redis error) is not taken as "not held": it is a failed move, logged as `Failed to move job to final state`.
  - Sandboxes bake in the settings they were created with, the SSRF allow list among them. Every connect compares the stored settings with a snapshot of the ones the current sandboxes were built with (`sandboxSettings`, taken when the managers are created and on each recycle), not with the previous connection's: a connect that stored new settings and dropped before comparing must not make the next one look unchanged. On a change, every manager is `markStale()`d, and an idle one (no in-flight job) is invalidated at once; a busy sandbox finishes its job first.
  - A connect that finds the generation changed or the socket down once its settings are in bails out: no recycle, no lease check, no gate. The next connect does all of it.
  - Logged: `Reconnected: in-flight jobs keep running, polling resumes` with `inFlightJobs`.
- **Leases are checked, not assumed.** The API answers `extendLock` with `{ leaseLost }` (BullMQ's `extendLock` returns 0 when the token no longer holds the lock). `leaseTracker` (`src/lib/lease-tracker.ts`) keeps one deadline per in-flight job.
  - **Timing.** A lease is trusted for 90 s (`trustMs`) from the moment the renewal that confirmed it was *sent*, read off `performance.now()`, so neither a slow answer nor a wall-clock jump stretches it. The lock is 120 s from the API's own renewal, which is later still, so a lease is given up at least 30 s before the lock it stands for can expire. The first deadline starts when the poll's answer arrives, just after the API took the lock. An older confirmation never moves it back, and it fires once (a timer reset on each confirmation), whether or not the worker is connected. Renewals go out every 30 s while connected and at once on every reconnect; none is sent while disconnected.
  - **A lease is given up** when the API answers `leaseLost: true` or the deadline fires. An answer with no body (an older API) confirms nothing and gives nothing up.
  - **What a give-up does.** The job is marked given up (`lease-lost`) and its lease forgotten, so nothing renews it again. Only its own slot's sandbox manager is invalidated, which kills its engine; other slots are not touched. From then on the job reaches the API by no route. Each job gets its own client (`buildJobApiClient` in `worker.ts`) with the given-up check (`execute/given-up-guard.ts`) on both sides of the reconnect handling: over it, a call made after the give-up throws `JobGivenUpError` at once; under it, the check runs again when the call is actually sent, after any wait for the connection gate and before each resend, so a report that started waiting for a reconnect before the give-up is dropped rather than sent once the API is back. That covers the handler's own calls (`uploadRunLog`, `sendFlowResponse`, #584's `reportFlowStatus` / `reportBestEffort`, …) and the lease renewals (`extendLock`), so a renewal held at the gate does not extend the lock of a job nobody runs. `completeJob` is the one call checked only when it is made: the handler has returned by then, so the result is real, and `holdsLease` on the API takes it only from the token that still holds the lock. Every RPC the engine sends through the worker (`updateRunProgress`, `updateStepProgress`, `uploadRunLog`, `sendFlowResponse`, `resolveInlineFlow`) is refused by `engineRunScope`, which reads `isGivenUp` off the job context, and is otherwise forwarded through the job context's `apiClient`, the current job's own client, rather than the client the sandbox was created with, so this holds for a sandbox prewarmed or reused from an earlier job too. A job that is over counts as given up for these checks, because its `inFlightJobs` entry is gone; and `sandboxManager.acquire` throws, so a job given up while it was still provisioning never starts an engine, prewarmed or fresh. The poll loop sends no `completeJob`, so no verdict, and no #584 quick retry, ever leaves the worker. The engine's own HTTP calls to the API (log file uploads, with its engine token) do not pass through the worker; they end when the engine is killed. The slot goes back to polling, and the API's stalled scan redelivers the job once its lock expires.
  - A sandbox the give-up invalidated is not prewarmed again; the slot starts a fresh one for its next job.
  - Logged: `Lease lost: stopping the job, the API may already have handed it to another worker` with `reason` (`refused by the API` / `not renewed in time`) and `leaseAgeMs`; each dropped engine RPC logs `[engineRunScope] Dropped an engine RPC for a job this worker gave up` at info. The job's own failure (its killed engine, or a call the guard refused) is logged at info as `Job stopped: this worker gave it up`, not as `Job execution failed`, and a refused sync-caller response is not logged as a failure. The `Job finished` line carries `givenUp: 'lease-lost'`, read after the completion so a give-up while it waited for a reconnect counts, and `completed: false`.
- **A poll loop that throws is restarted** after 1 s, in place. `startPollingWorkers` settles on `Promise.allSettled`, so one failing loop cannot end the set and let the next connect start a second set beside the survivors. Each loop is bound to the `AbortSignal` of the `start()` that launched it, so a loop that outlived `stop()` does not come back after the next `start()` resets `stopped`.
- **A stop drains.** `worker.stop()` stops polling at once and waits up to `system.getShutdownGraceMs()` until no job is in flight and no loop runs. The grace is `AP_WORKER_SHUTDOWN_GRACE_SECONDS`: default 60, trimmed, blank or invalid → default, capped at 3600. The socket stays up meanwhile, and a draining worker still reconnects after an API restart (`closing`, set only after the drain, is what stops reconnects). Only then are sandboxes shut down.
  - **Parked polls are ended by the API, not walked away from.** A poll walked away from stays a waiter in the dispatcher for up to `WAITER_TIMEOUT_MS` (50 s), and a job handed to it would be acked to a loop that had stopped: active, unowned, and stuck until the stalled scan. So the poll is never raced against `stop()`. `stop()` first sends `stopPolling` (bounded by 5 s or the grace); while disconnected it cannot, so a worker that reconnects while stopping sends it before it opens the connection gate, ahead of any poll that was waiting for the gate through the outage. The API aborts that connection's poll signal, combined with the socket's disconnect signal through `AbortSignal.any`, so the parked polls answer `null` the way a disconnect's do (#589), a job dequeued in the same turn goes back to the queue (`returnToQueue`), and every later poll on that connection answers `null` without reaching the dispatcher. An API from before #585 has no `stopPolling` handler and answers with an RPC error. The worker logs that at info and drains anyway; its parked polls end within their 50 s budget, and a job one of them brings is not lost: it is run if the grace allows, and otherwise given up (`shutdown`) and redelivered by the stalled scan.
  - Jobs still in flight when the grace expires are given up (`shutdown`) before their engines are killed, with the same guards as a lost lease, so they skip a `completeJob` that could only time out on the closing socket and report no run status over the redelivered copy. The API's stalled scan redelivers them once the lock expires.
  - Logged: `Stopping: no new jobs taken, waiting for in-flight jobs to finish`; `Shutdown grace expired, abandoning in-flight jobs` with `abandonedJobs` when the grace ran out; `Worker stopped` with `inFlightJobsAtStop` and `abandonedJobs` always.
  - `main.ts` forces the exit only at grace + 15 s. The shipped `docker-compose.yml` sets `stop_grace_period: 90s` on the worker, strictly above that, since Docker's default 10 s would kill the drain; the two move together. Other deployments (QA's own compose file, Kubernetes) need the same. `docker compose pull` does not change an existing install's compose file: re-running `run.sh` refreshes it, and a git checkout gets it with `git pull` (`tools/update.sh`).
  - The API's CE suites that run a real worker pin the grace to 5 s in `vitest.setup.ts`, which is what `test/helpers/worker-teardown.ts`'s 15 s budget is sized for.

**A poll belongs to its socket (#589).** The app's `poll` is a long-poll: `queue-dispatcher.ts` parks it as a waiter for up to `WAITER_TIMEOUT_MS` (50 s) and hands the next dequeued job to the oldest waiter. `machine-controller.ts` gives each socket's handlers an `AbortSignal` (`disconnected`) that aborts on the socket's `disconnect`, and `jobBroker.poll({ queueName, signal })` passes it to the dispatcher.
- On abort, the dispatcher drops that socket's waiters (they resolve `null`), so the next job goes to a live worker. A poll that arrives on an already-closed socket returns `null` at once, before the registry upsert, so it cannot re-register a worker that `onDisconnect` just removed.
- If a job was handed out in the same turn the socket closed, the `poll` handler returns it with `jobBroker.returnToQueue` (`moveToDelayed(now + 100 ms)`) instead of acking it. It logs `[workerRpc#poll] Worker disconnected while its poll was pending`.
- Before this, a worker restart left one waiter per slot behind. The next jobs went to them and were acked into the closed socket. They then sat active until the 120 s lock expired and the stalled check re-queued them, so they ran ~139 s late with `stalledCounter: 1`. A sync caller had already had its 504, and `syncDeadline` (#533) does not apply to a redelivery.
- Not covered: a half-open TCP connection that Socket.IO has not noticed yet (up to its ping timeout). Its jobs still go through the stalled path.
- Not covered: the engine's own upload of the run log (`engine-file-api.ts`, `PUT /v1/files/:fileId`, 3 retries 3 s apart) goes straight to the API, not through the worker, so the connection gate cannot hold it. A run that finishes during an API outage longer than that budget fails as `INTERNAL_ERROR` (`fetch failed`, `getaddrinfo ENOTFOUND app` on the Docker stand), finally since #584. Tracked as #595.

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
  `startInlineFlowRun` is called: the API only checks that the parent is in the caller's project, so
  a foreign same-project parent would let the engine attach inline children, and the inline depth
  they count from, under an unrelated run (#525). When #525 was found, those children also failed
  their parent, which made it a way to fail and resume a foreign paused run; since #521 inline
  children are created with `failParentOnFailure: false`. A nested inline call names its own inline
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
- `source` — where the code came from: `store` (the qadam version store, #779), `bundled` (the
  image's dist, at the pinned version or by name), `installed` (a workspace install) or `dev`.
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
  prewarm, which logs `Prewarm failed` and leaves the slot lazy. It runs once per `start()`: the
  loops outlive a reconnect (#585), so a reconnect neither prewarms nor needs to. Each slot's poll
  loop calls `sandboxManager.prewarm()` before its first poll and outside its crash restart
  (`prewarmSlot` in `worker.ts`), so no job can race it. It is skipped when the loop would not poll
  (the start's signal aborted, the connection gate closed, or an API version mismatch) and raced
  against the start's signal. A slot whose sandbox a settings change recycled or a give-up
  invalidated is not prewarmed again: its next job starts the sandbox.
  Forked engines only: a reusable sandbox (`canReuseSandbox()`) that does not run in an isolate —
  `UNSANDBOXED`, `SANDBOX_CODE_ONLY`, and dev with either. It provisions the engine with no qadams
  and starts the sandbox with no platform and no flow version, logging
  `[sandboxManager#prewarm] Sandbox started before its first job` with `prewarmMs`. Best effort: any
  failure is a warning, the sandbox is dropped and the slot polls as before. A prewarm abandoned by a
  stop cannot leak an engine: every `invalidate`/`shutdown` bumps the manager's generation, so a
  prewarm that sees it changed starts no sandbox after the install, and shuts down (quietly, at
  debug) one that was already starting. A reconnect bumps nothing, and need not: the slot's own loop
  is the manager's only user, so a prewarm never overlaps a job or a second prewarm on it. Isolate modes (`isIsolateMode`
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

## Sandbox Filesystem (isolate modes, #375)
`SANDBOX_PROCESS` / `SANDBOX_CODE_AND_PROCESS` run the engine inside isolate with cwd `/root`, so
every path the engine resolves has to be mounted there by `create-sandbox-for-job.ts`:
- `/root/common` — the shared cache's engine bundle (`main.js`) and any qadams installed into the
  workspace.
- `/root/packages/qadams`, `/root/packages/shared`, `/root/node_modules/.bun` — the bundled qadams
  and their dependency closure. The qadam dists are plain `tsc` output that `require`s
  `@aiqadam/qadams-framework`, `@aiqadam/qadams-common`, `@aiqadam/shared` and third-party packages
  through the per-package symlink farms; the engine resolves the bundled root as
  `path.resolve('packages/qadams')`, which from cwd `/root` is `/root/packages/qadams`. Without
  these mounts every bundled qadam fails with `QadamNotFoundError`. Fork modes (`UNSANDBOXED`,
  `SANDBOX_CODE_ONLY`) run with cwd at the repo root and mount none of them.
- `/etc/resolv.conf` — `sandbox-etc.ts` materialises the container's own `/etc/resolv.conf` into
  `os.tmpdir()/qadam-flow-sandbox-etc` and isolate mounts that directory as `/etc`. The baked asset
  (`packages/server/api/src/assets/etc`, Google DNS) is only the fallback when the host file is
  unreadable or has no nameserver. Docker's embedded resolver (127.0.0.11) is what resolves compose
  service names like `app`, which the baked file cannot.

## Isolate Boot Preflight (#709)
An isolate mode in an unprivileged container used to fail per job, mid-run, with `Cannot run proxy,
clone failed: Operation not permitted`. `sandbox/isolate-preflight.ts` probes once, before the worker
accepts any job: on the first connect that reports an isolate `EXECUTION_MODE`, the worker runs
`isolate --box-id=<probe> --cleanup/--init/--run -- /bin/true/--cleanup` (box 0 is reserved for the
probe; jobs use 1..`AP_WORKER_CONCURRENCY`). A failure is fatal at boot — the same kill-switch shape
as the egress stack — with a message pointing at `docker-compose.sandboxed.yml`. The probe is per
mode, so a reconnect with the same mode does not re-run it; `UNSANDBOXED`/`SANDBOX_CODE_ONLY` skip it
entirely. The bundled image must create `/var/local/lib/isolate` (isolate's `box_root`), which only
the sandbox-e2e harness did before #709.

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
- On a retry the wait still spans every earlier attempt and its backoff: seconds for an `EXECUTE_FLOW` job since #584, 8 minutes for any other job.
- Measured on the API, so worker clock skew cannot enter it. The API replicas' clocks must still agree.

**`[eventLoopMonitor] Event loop was blocked`** (app and worker, warn). This is `eventLoopMonitor` from `@aiqadam/server-utils`, started in `setupApp` and in the worker's `main`.
- It samples `perf_hooks.monitorEventLoopDelay` every 10 s and writes only when the window's `maxLagMs` is ≥ 500 ms. It also reports `p99LagMs` and `meanLagMs`.
- Every value is net of the 20 ms sampling resolution, because the histogram records whole sample intervals.

`[workerRpc#poll] Poll request received` is **debug** since #587. Every slot long-polls continuously, so at info it was most of the app's log. A hand-out is still logged at info (`Returning job to worker`).

## Shared Cache Volume (#372, #586)
All worker replicas mount one `cache` volume (`/usr/src/app/cache`). An in-process `memoryLock` keeps only one container's own jobs apart, so every write to that volume also needs a lock on disk (`fileLock` from `@aiqadam/server-utils`, built on `proper-lockfile`; a lock whose holder stops refreshing it is stale after 5 min unless the caller passes `staleMs`):
- **Qadam installs** (`qadam-installer.ts`, #373): `fileLock` on the `common` workspace, i.e. `v12/common.lock`.
- **`cacheState.getOrSetCache` with `crossProcess: { log }`** (`cache/cache-state.ts`, #586). Only the two callers whose `installFn` writes shared state on the volume opt in: code builds and the engine copy. The flow-version and qadam-metadata caches only fetch, so they stay on the `memoryLock` alone; a lock there would serialize every draft flow-version fetch across replicas.
  - The memory fast path is unchanged: a hit takes no lock.
  - A miss takes the in-process `memoryLock`, then the named lock `<folder>.cache-state`, then re-reads `cache.json` from disk. The replica that loses the race therefore uses the winner's result instead of installing again.
  - The lock is `fileLock` with `createPath: false`, so on disk it is `<folder>.cache-state.lock` and nothing is created for the name.
  - The name is separate from the installer's `common.lock`, so an engine copy never waits behind another replica's `bun install`. Two locks held at once on the same `path` would break `proper-lockfile`, which tracks held locks by path.
  - The lock goes stale after 60 s (`staleMs`), below the ~3 min wait, so a waiter takes over the lock of a killed holder instead of timing out. A live holder is never taken over: `proper-lockfile` refreshes a held lock every `stale / 2`.
  - **The lock wait times out (~3 min) → install without it.** A cold build (`bun install` up to 10 min + esbuild up to 5 min) can outlast the wait. The fallback re-reads the disk first, then builds alongside and logs `[cacheState] Timed out waiting for another replica`. That is safe because every opted-in `installFn` publishes by temp file + rename.
  - Only a failure to *take* the lock falls back. `fileLock` reports it as its own error, checked with `fileLock.isAcquireTimeout({ error, path })`, which matches only a timeout on that lock's own `path`. Any error `installFn` throws under the lock, an `ELOCKED` or a timeout on some other lock it took included, fails the job as before and is not retried unlocked.
- **`fileLock` never crashes the worker on a compromised lock.** `proper-lockfile`'s default `onCompromised` throws from its refresh timer, i.e. as an uncaught exception. `fileLock` logs `[fileLock] Lock was compromised while held` instead and ignores the release failure that always follows a compromise. `fileLock.runExclusive` now requires a `log`. When `fn` throws and the release fails too, `fn`'s error is the one thrown and the release failure is logged. `fn` receives `{ isCompromised }`: a writer that publishes by temp file + rename (`cache.json`, code builds, the engine copy) can finish regardless. The qadam installer, whose `bun install` writes in place into the shared workspace, does not:
  - **Forward progress (#591).** It checks `isCompromised()` before removing abandoned members (below), before each `bun install` (the batch, and every one of the one-by-one retries), before each verification and, with `OFFICIAL_QADAMS_INSTALL_ENABLED` on, again between verification and the `ready` markers, and throws once the lock is lost. Its own setup writes come before the first check and are not guarded: the workspace files, archives and member `package.json`.
  - **Rollbacks (#593).** Once the installer sees the lock as lost, no rollback writes the workspace: the workspace is no longer its to write. That covers a failed single-qadam batch, a failed one-by-one retry, no survivor after the retries, and a failed integrity pass. `rollbackInstallation` checks before its directory removals and `restoreLockfile` again before the lockfile write, and each skips its writes, so the installer neither removes a qadam directory nor restores or removes `bun.lock`. The original error is still thrown.
  - **What a skipped rollback leaves is not harmless,** and the next install to take the lock handles it. A member whose dependencies do not resolve fails every later `bun install` in the workspace, `--filter` included (measured on bun 1.3.14: `bun install --filter ./qadams/b` exits 1 when sibling `qadams/a` pins a version that does not exist). In `UNSANDBOXED` mode that is the shared `common` workspace of every tenant. And the lockfile may hold refusals that nothing verified. Both are recognised by the same sign: a member under `qadams/` (defined below) without a `ready` marker, found when the lock is acquired, before this install writes members of its own. Such a member was left by an earlier install that never finished: a worker killed mid-install, or an install that stopped after losing the lock.
    - **The lockfile's refusals are not excused.** With the flag on and the snapshot holding any refusal, `readWorkspaceBeforeInstall` returns an empty `refusedKeys`, whether or not the leftover is in this install's batch. A re-request of the same qadam therefore fails closed instead of excusing the alias its abandoned install wrote. The snapshot's bytes are dropped as well (`lockfileContents: undefined`), so a rollback removes `bun.lock` instead of putting the same refusals back for the next attempt to excuse, and with no lockfile nothing is excused. Without a refusal in the snapshot, distrust changes no verdict, so the lockfile is snapshotted and restored as usual: a leftover alone never costs the workspace a full re-resolve.
    - **Leftovers outside the batch are removed** by `removeAbandonedMembers`, under the held lock, before `bun install`. Leftovers in the batch are rewritten by `createQadamPackageJson` and reinstalled. Removal runs after this install has written its own members, not right after the snapshot. The leftovers are the only record that `bun.lock` may hold unverified refusals, and this batch's own unmarked members carry that record on if the install fails or is killed from then on. Removed earlier, a failed setup write or a kill would let the next install trust the lockfile again.
    - **A member is a directory holding a `package.json`.** The walk descends into every other directory except `node_modules`, and it never removes a directory with a `ready` file anywhere below it. A qadam name is not checked against npm's naming rules on the way here. bun 1.3.14 installs an ARCHIVE dependency named `foo/bar` at `qadams/foo/bar-1.0.0` (exit 0), and the qadam `@foo` lives at `qadams/@foo-1.0.0`. Reading the layout off the first path segment would remove `qadams/foo`, ready qadam included, on every unrelated install, with the flag off as well as on.
  - **What is still open:**
    - *No fencing.* `isCompromised()` turns true only when the lock's refresh notices, up to one refresh interval (stale / 2, i.e. 150 s for the 5 min lock) after another replica could already have taken the lock over, and with no bound if the refresh I/O hangs. `proper-lockfile` also reports a compromise when nobody else holds the lock (a refresh failing past the stale threshold, or the lock directory gone). Every check narrows the window in which two holders write the workspace at once; none closes it. Inside that window the integrity gate can still be bypassed. Replica A has not yet noticed it lost the lock, and B now holds it. Between B's `bun install` and B's verification, A's `restoreLockfile`, or A's still-running `bun install`, can rewrite B's `bun.lock`. B's integrity pass then reads A's lockfile instead of the one its own install wrote. For a batch with an official qadam, `assertBatchIsCovered` fails it if B's entries are missing. A custom-only batch has no such check, because `assertBatchIsCovered` covers official qadams only, so B marks its qadams `ready` without having verified what bun installed for them. The window is narrowed, not closed. The availability side, in the same window: B can remove A's in-progress member, and B's own `bun install` can fail on a leftover A wrote after B's scan.
    - *A fail-closed lockfile removal is sticky for refusals that were legitimately excused.* An official-scope entry already in the workspace from a `ready` qadam (logged with "Rename it") stops being excused once a leftover has caused `bun.lock` to be removed. With no pre-image, every refusal counts as introduced, so flag-on installs in that workspace fail until that qadam is renamed or removed. The removal also costs one full re-resolve of the workspace.
- **`cache.json` writes** go through a temp file named `<file>.<hostname>.<uuid>.tmp`, fsync'd, then `rename`d. They no longer use `write-file-atomic`: that library names its temp file from pid + an invocation counter, every worker container runs as pid 7, and so two replicas' n-th writes collided on one temp path (`ENOENT ... chown cache.json.<n>`). A replica killed mid-write leaves its temp file behind; that is expected and harmless, since nothing reads it. Reading tolerates a bad file: a missing (`ENOENT`, with no separate existence check to race against), empty, truncated or non-string-map `cache.json` is treated as empty, which costs one rebuild and does not fail every job that touches the folder. Any other read error still fails.
- **Code builds** (`code/code-builder.ts`) build into `<step>.build-<ms>-<uuid>` beside the live step directory and are swapped in. Each build writes `.source-hash`, the hash of the source it was built from, into its directory.
  - `.source-hash` is the authority for a hit, from memory and from `cache.json` alike. `cache.json` lives inside the step directory, and after a lock-timeout fallback a replica that lost the swap can still save its own hash into the winner's build. A hit therefore also reads `.source-hash`, one small file, and rebuilds when it names another source. A step directory that is gone altogether is a miss, which waits on the lock and reads again. A directory from before #586 has no `.source-hash`; for it `cache.json` alone decides, so an upgrade does not rebuild every step once.
  - A compilation error is reported against the step path, not the build directory.
  - The old build moves to `<step>.retired-<ms>-<uuid>`, the new one is renamed into place, and the old one is removed on a best-effort basis: a deletion failure is logged and does not fail the job.
  - The step directory is missing only between the two renames, not for the length of a `bun install` + esbuild.
  - If the second rename fails, the previous build is renamed back.
  - If the second rename finds the target taken, another replica swapped in its own build during a lock-timeout fallback. That build is kept, and this replica's dropped, only when its `.source-hash` matches this replica's source. Otherwise it is retired and the swap retried, up to 3 attempts, after which the job fails.
  - A failed build removes its own build directory and leaves the previous build in place.
  - Each build first removes `<step>.build-*` / `<step>.retired-*` leftovers older than 20 min, the longest a build can run (bunRunner's timeouts). Such leftovers come from a worker killed mid-build or mid-swap. Younger ones may be another replica's build in progress. The sweep runs only when that step rebuilds, so a leftover beside a step that never rebuilds again stays on the volume; that is an accepted cost.
  - A leftover's age comes from the `<ms>` in its name, not from its mtime: `rename(2)` does not update the moved directory's own mtime, so a build retired a moment ago would still look as old as the build. A name without a time falls back to the directory's ctime.
- **The engine cache id** (`engine/engine-installer.ts`) is the sha256 of `dist/packages/engine/main.js`, computed once per process. It used to be a per-process `nanoid()`, which made every worker restart a guaranteed miss: every fresh replica copied the engine and rewrote `common/cache.json` on its first job, in the same second after a deploy. A restart of the same image is now a hit. A different bundle, including one replaced by hand inside the container, still misses.

## Retry by Failure Class (#584)
A failed `EXECUTE_FLOW` attempt is retried according to **where** it failed, not after 8 minutes whatever happened. The worker decides, because only it knows whether the engine received the operation; the broker applies the decision.

- **The retry options** (`job-queue/job-retry.ts`). `jobQueue.add` gives every `EXECUTE_FLOW` job `jobRetry.executeFlowJobOptions`: `attempts: 4` and the built-in exponential backoff from 2 s with `jitter: 0.5`. That is retries after about 2 s, 4 s and 8 s, each down to as little as half, so slots that failed together after a deploy do not retry together. `flow-run-service.ts#addToQueue` produces these jobs, and `migrations/unify-old-queues-to-one.ts` re-adds legacy ones; both go through `jobQueue.add`, so both get the same options. `platform-queue-migration.service.ts` copies `attempts` and `backoff` along with a job.
  - Only built-in BullMQ options are persisted, so an app without this code still retries such a job; it just cannot tell failures apart.
  - Every other job type, and every scheduler, keeps the queue default: `attempts: 2`, one retry after 8 minutes. User-interaction jobs keep `attempts: 1`.
- **The verdict:** `ConsumeJobResponse.retryable`, sent with `completeJob`.
  - `true`: the attempt failed **before the engine received the operation**, so nothing ran. `execute-flow.ts` sends this for a failed flow-version fetch, a failed provisioning (qadam install, code build, a cache race such as #586), and a sandbox that did not start. The line is `operationSent`, which is set just before `sandbox.execute`.
  - `false`: never retry. Either the engine may have executed steps (anything thrown from `sandbox.execute`, or an `INTERNAL_ERROR` the engine reported), or the outcome is final and already reported: flow version not found, a qadam pin the image lacks, a RESUME without its logs file, or a code step whose dependency `bun install` cannot resolve (`UnresolvableDependencyError`: a registry 404, or no version matching; an unreachable registry stays retryable). That last one is reported as `INTERNAL_ERROR`, because the run view shows `internalError`, which carries the install output, only for that status; it is reported with a plain `reportFlowStatus`, since nothing has run and a swallowed report would leave the run `QUEUED`. On the last attempt a throwing report leaves the run `QUEUED` either way; on a pre-#584 job it buys the 8-minute retry, which reports again. A retry starts again from the trigger and would repeat every side effect of the first attempt. The run stays `INTERNAL_ERROR` (or `FAILED`), visible in the UI, and the user can retry it.
  - A report after the operation was sent is best-effort (`reportBestEffort`): a report that throws is logged and does not change the verdict, and it cannot reach the `catch` and report the run a second time. Tearing the sandbox down (`invalidate`, `release`) is best-effort for the same reason (`tearDownSandbox`): from the `finally`, a throw would turn a run that succeeded into a failure retried from the trigger.
  - Absent: the failure was not classified. For an `EXECUTE_FLOW` job that is a throw before execution the handler does not classify (the sandbox slot, parsing the job, a report that fails before the operation was sent, such as the #510 deadline one), so the quick backoff applies. Other job types never send a verdict.
  - A handler throws `ClassifiedJobFailure` (`execute/job-failure.ts`) to carry the verdict, or sets `retryable` on a returned fire-and-forget result. The poll loop (`readRetryable`) forwards it, and unwraps `original` for the stdout/stderr logs.
- **The broker.** `completeJob` passes `retryable: false` to `moveToFailed` as an `UnrecoverableError`, which BullMQ never retries; anything else is a plain `Error` and the job's own backoff applies. `jobRetry.logFailedAttempt` then logs one of three lines, with `failedAttempt` and only the first line of the failed reason (the rest is the engine's stdout/stderr):
  - `[jobRetry] Attempt failed, retrying`, with `retryInMs`;
  - `[jobRetry] Attempt failed after the engine received it, or with a final outcome; not retrying`;
  - `[jobRetry] Attempt failed, no attempts left`.
- **The run while a quick retry is pending.** `ConsumeJobRequest.canRetryBeforeExecution` tells the worker whether a failure before execution will be retried within seconds. It is BullMQ's own `attemptsMade + 1 < attempts` check, on a job carrying the quick backoff (recognised by its 2 s base delay). When it is true, `execute-flow` reports nothing: the run stays `QUEUED` and a sync caller keeps waiting, because the next attempt answers both. Reporting `INTERNAL_ERROR` would tell the caller the run failed and then run it anyway. On the last attempt the handler reports `INTERNAL_ERROR` itself, as before.
- **Jobs enqueued before #584** still carry `attempts: 2` and the 8-minute backoff, so `canRetryBeforeExecution` is false for them and they retry once after 8 minutes, as before, until they drain. A `false` verdict still stops their retry.
- **A user retry** (`FROM_FAILED_STEP`) re-enqueues the run under its own id, and BullMQ ignores an add under an id it still holds. `flowRunService.retry` therefore calls `jobQueue.removeFinishedOneTimeJob` first, which removes the run's job when it is `failed` or `completed`, and also when it is `delayed` and the run has already ended. A failed job's Redis record is otherwise kept, as before.
  - **In flight** means `waiting`, `prioritized`, `active` or `waiting-children`, or `delayed` on a run that has not ended. The common source of that is the rate limiter's re-delay (`job-broker.ts`, `moveToDelayed` after an interceptor, up to 600 s), then a pending quick retry. The call then returns `alreadyInFlight: true`, and `retry` returns the run as it is, without the `QUEUED` update, the retried event, the payload offload or the add: the job holding the id is the one that will run.
  - **A `delayed` job on a run that ended** is a pre-#584 job's 8-minute retry, or one from the mixed-version window. Left alone, it would swallow the user's retry (the run stays `FAILED`, and `ap_retry_run` reports the old failure as the retry's result) and later run from the trigger instead of the requested `RESUME`. It is removed instead, so the user's retry replaces it and the run still runs once.
  - **`unknown`** is re-read. If the job went away between the two reads, the id is free and the retry goes ahead. If its hash is still there but no state list holds it, BullMQ would still ignore an add under the id, so it is removed as a `failed` job would be, with the same error handling.
  - **A failed removal.** BullMQ gives a locked job and a missing one the same error, so the job's add `timestamp` tells them apart: a job under the id with a different `timestamp` is a concurrent retry's re-enqueue, so `alreadyInFlight: true`. A missing job, the same job, or an error on the re-read rethrows the original removal error. That includes a `delayed` job a worker picked up in the moment between the read and the removal; retrying again then finds it in flight.
- **Mixed versions.** The version gate compares the root `package.json` `version`. Before #798 that separated releases only: every build of `main` was `2.0.0`, so between `main` builds (QA, local stands) a new app could hand a job to a pre-#584 worker. Since #798 each `main` image reports its own `<next>-main.<n>`, so the gate separates `main` builds as well (a local build from source still reports the tree's version, so local stands keep the old behaviour). That worker sends no verdict, so a failure after execution is retried from the trigger up to three times within about 14 s. On QA this is a one-time window during the first deploy of #584, since auto-update recreates the app before the workers. Upgrade the workers with or before the app. The other mix, a new worker with an old app, is safe: the old app ignores the verdict and keeps the 8-minute retry.
- **Rolling back past #584:** the `EXECUTE_FLOW` jobs this version enqueued keep `attempts: 4` and the quick backoff. The older broker sends no verdict, so until they drain, any failure of theirs, including one after execution, is retried up to three times within about 14 s. The same holds during a multi-replica app deploy's overlap, when an old app replica dequeues such a job and hands it to an old worker. Nothing crashes: the options are built-in BullMQ ones.
- **Not covered:** a worker that dies mid-run (OOM kill, SIGKILL) reports nothing. Its job comes back through BullMQ's stalled check and runs again from the trigger. The retried run's record keeps no trace of the failed attempt: the retry is visible only in the log lines above and in `attemptsStarted` on the `Job finished` line. A sync run's #510 deadline is checked on the first delivery only, so a quick retry of one runs even past it. The backoff is at most about 14 s in total.

## Version Gating (rolling-deploy safety)
During a rolling upgrade the app and worker fleets briefly run different builds. Mixing them risks flow-schema/contract skew and silent run corruption, so dispatch is gated on an exact release match — both sides enforce it, whichever runs the newer build:
- **App side** (`worker-rpc-service.ts#poll`): if `input.workerProps.version !== apVersionUtil.getCurrentRelease()`, it logs a warning and returns `null` (withholds the job). An old worker can never receive jobs from a new app.
- **Worker side** (`worker.ts#pollAndExecute`): if the connected app's `APP_VERSION !== AP_VERSION`, it pauses polling (`VERSION_MISMATCH_POLL_PAUSE_MS`, 10s) and retries. A new worker won't pull from an old app.
- **Recovery** is automatic: once both fleets converge on the same release, polling resumes on the next cycle — no restart needed.
- **Version source**: `apVersionUtil.getCurrentRelease()` reads `process.cwd()/package.json`, which is the deploy-root version for both processes — not a workspace `package.json`: the release (`2.0.0`) in a release image, `<next>-main.<n>` (`2.0.1-main.1234`) in an image built from `main`, stamped by the Dockerfile (#798). So two different `main` builds count as different versions here, exactly like two releases. On read failure it falls back to `0.0.0` symmetrically, so a misconfigured-but-identical pair still matches.

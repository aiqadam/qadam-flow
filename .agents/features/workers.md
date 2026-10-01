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
- **`fileLock` never crashes the worker on a compromised lock.** `proper-lockfile`'s default `onCompromised` throws from its refresh timer, i.e. as an uncaught exception. `fileLock` logs `[fileLock] Lock was compromised while held` instead and ignores the release failure that always follows a compromise. `fn` receives `{ isCompromised }`: a writer that publishes by temp file + rename (`cache.json`, code builds, the engine copy) can finish regardless, while the qadam installer, whose `bun install` writes in place into the shared workspace, checks it before each `bun install` (the batch, and every one of the one-by-one retries) and each verification, and throws once the lock is lost. It does not restore `bun.lock` on the way out, because the workspace is no longer its to write. `fileLock.runExclusive` now requires a `log`. When `fn` throws and the release fails too, `fn`'s error is the one thrown and the release failure is logged.
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

## Version Gating (rolling-deploy safety)
During a rolling upgrade the app and worker fleets briefly run different builds. Mixing them risks flow-schema/contract skew and silent run corruption, so dispatch is gated on an exact release match — both sides enforce it, whichever runs the newer build:
- **App side** (`worker-rpc-service.ts#poll`): if `input.workerProps.version !== apVersionUtil.getCurrentRelease()`, it logs a warning and returns `null` (withholds the job). An old worker can never receive jobs from a new app.
- **Worker side** (`worker.ts#pollAndExecute`): if the connected app's `APP_VERSION !== AP_VERSION`, it pauses polling (`VERSION_MISMATCH_POLL_PAUSE_MS`, 10s) and retries. A new worker won't pull from an old app.
- **Recovery** is automatic: once both fleets converge on the same release, polling resumes on the next cycle — no restart needed.
- **Version source**: `apVersionUtil.getCurrentRelease()` reads `process.cwd()/package.json`, which is the deploy-root release version (e.g. `0.83.0`) for both processes — not a workspace `package.json`. On read failure it falls back to `0.0.0` symmetrically, so a misconfigured-but-identical pair still matches.

# #214 — "Three uncalled functions hide live bugs": all three already resolved or deliberately out of scope

**Status:** no code change required in this ticket's own scope.
**Investigated:** 2026-10-24, on `agent/214-three-uncalled-functions-hide-live-bugs`
(branched from `main` @ `2e5da75b`).

## What the issue reported

Three uncalled functions, each hiding a live defect:

1. `deleteStaleCache()` in the worker was never called, so a `LATEST_CACHE_VERSION` bump
   leaked the previous version's cache directory forever (unbounded disk growth).
2. `setPlatformOAuthService` was never called, so the `PLATFORM_OAUTH2` connection type
   always threw when claimed.
3. The hard-delete job handlers (`HARD_DELETE_PLATFORM`, `HARD_DELETE_PROJECT`) were never
   registered with the job queue.

## Finding: the issue's own comment thread already did this investigation

The thread on #214 (four comments, the last from a prior agent run) already tracked all
three items to a conclusion, verified against progressively newer commits. Re-verified
independently here against the current branch tip:

| Item | Resolution | Evidence on this branch |
| --- | --- | --- |
| 1. Worker cache never evicted | **Fixed**, merged PR [#225](https://github.com/aiqadam/qadam-flow/pull/225) (`55138011`) | `packages/server/worker/src/lib/main.ts:19` calls `void deleteStaleCache()` on startup, fire-and-forget by design (comment at `:16-18` explains why: a cleanup failure must not stop the worker accepting jobs). Covered by `test/lib/main.test.ts` and `test/lib/cache/cache-paths.test.ts`. |
| 2. `PLATFORM_OAUTH2` bounded defect (bare `Error` → 500) | **Fixed**, merged PR [#239](https://github.com/aiqadam/qadam-flow/pull/239) (`9098dbe5`) | `packages/server/api/src/app/app-connection/app-connection-service/oauth2/index.ts:21-27` now throws `QadamFlowError({ code: ErrorCode.INVALID_APP_CONNECTION, ... })` instead of a bare `Error`. `INVALID_APP_CONNECTION` is absent from the error handler's `statusCodeMap`, so it falls to the `BAD_REQUEST` default — a typed 4xx instead of an unhandled 500. |
| 2. Platform-managed OAuth2 apps (the feature `setPlatformOAuthService` exists to be wired into) | **Deliberately not built** — documented in #239's own scope note | `setPlatformOAuthService` (same file, `:47-49`) still has no caller anywhere in `packages/server/api/src` (`grep -rn "setPlatformOAuthService" packages/server/api/src` returns only the definition). `packages/web/src/features/connections/hooks/oauth-apps-hooks.ts` still returns a literal `{}` with no query or endpoint behind it. There is no entity, migration, or endpoint serving a platform-level OAuth2 app. Building this is a full feature (storage entity, CRUD endpoints, platform-admin UI, clean-room reimplementation per `.agents/rules/edition-safety.md`'s doubt clause), not a drive-by fix. |
| 3. Hard-delete job handlers unregistered | **Deliberately not done** — same reasoning documented in #239's scope note | `packages/server/api/src/app/platform/platform-jobs.ts:14` still defines `hardDeletePlatformHandler` with no registration call anywhere. `grep -rn "HARD_DELETE_PROJECT\|HARD_DELETE_PLATFORM" packages/server/api/src/app` hits only the enum (`helper/system-jobs/common.ts:34-35,100-101`) and the unregistered handler — nothing enqueues either job. `platform.controller.ts` registers no `DELETE` route at all, and `DELETE /v1/projects/:id` (`project-controller.ts`) calls `projectService.softDelete` only. Registering the handlers today would be a zero-behaviour-change diff: there is no enqueue path, no project-side hard-delete handler, no retention policy, and (per the thread) no authz check scoped to a hard delete. This needs its own design pass — enqueue-on-soft-delete, a retention window, the project-side handler, and safety against cascading through untested FKs — not a registration patch. |

Both `#225` and `#239` are present in this branch's `git log` (`55138011`, `9098dbe5`), so
nothing from either PR is pending re-application.

## Why no code change was made here

The issue's own thread (see comments on #214) already reached this conclusion and
recommended either closing the ticket as done-for-its-own-scope or splitting the two
remaining epics into their own tickets, leaving that call to a maintainer. Re-verifying
against the current tree confirms the thread's last comment is still accurate: the one
bounded, "do now" bug (item 2's 500-vs-400 defect) is shipped, and the two genuine epics
(platform-managed OAuth2 apps; a hard-delete/retention pipeline) are unbuilt by design, each
requiring its own scoping and design work that a single bug-fix PR should not absorb.

Writing a one-line call to `setPlatformOAuthService` or a bare job-handler registration
would be a "green diff, zero behaviour change" patch exactly as the thread describes —
the handlers would still never run because nothing enqueues the jobs, and the OAuth service
would still have no real implementation to register.

## Recommendation

- Close #214 as resolved for its own scope (items 1 and 2's bounded defect are shipped).
- If the two epics are still wanted, open them as new tickets: platform-managed OAuth2 apps,
  and a platform/project hard-delete retention pipeline. Neither belongs in a "fix the dead
  code" ticket.

# CE Alerts (Flow Failure Notifications)

## Summary
An Alert is a per-project subscription that mails a named recipient when a flow run finishes in a failed state. It is the only notification channel in this repo: `AlertChannel` has exactly one member, `EMAIL` (`packages/shared/src/lib/management/alerts/index.ts:5`). Alerts are stored one row per `(projectId, receiver)` pair and are keyed by **email address, not `userId`** — which is why membership has to be checked both when the alert is armed and again when mail is about to be sent. There is no alert-level audit trail: rows are hard-deleted and this repo persists no audit events (see `GLOSSARY.md`, "Audit Event").

## Key Files
- `packages/server/api/src/app/alerts/alerts-service.ts` — `sendAlertOnRunFinish`, `add`, `list`, `delete`, `deleteAllForProject`
- `packages/server/api/src/app/alerts/alerts-controller.ts` — `GET /`, `POST /`, `DELETE /:id`
- `packages/server/api/src/app/alerts/alerts-module.ts` — mounts the controller at `/v1/alerts` and registers the project-delete sweep hook
- `packages/server/api/src/app/alerts/alerts-entity.ts` — `alert` TypeORM entity
- `packages/server/api/src/app/database/migration/postgres/1784724891352-AddAlertEntity.ts` — creates the table and `idx_alert_project_id` (`breaking = false`, `release = '1.2.0'`)
- `packages/server/api/src/app/flows/flow-run/flow-run-hooks.ts:15` — the only production caller of `sendAlertOnRunFinish`
- `packages/server/api/src/app/project/project-service.ts:301` — `filterActiveMemberEmails`, the send-time revalidation
- `packages/shared/src/lib/management/alerts/index.ts` — `AlertChannel`, `Alert`, `ListAlertsParams`, `CreateAlertParams`
- `packages/server/api/src/assets/emails/issue-created.html` — the failure-alert template (sent via `emailService#sendFlowIssueAlert`, `helper/mail/email-service.ts:42`)
- `packages/web/src/features/alerts/api/alerts-api.ts`, `.../hooks/alerts-hooks.ts` — web client (`alertsApi`, `alertsHooks.useList`, `alertsMutations.useCreate/useDelete`)
- `packages/web/src/features/invitations/components/project-members-tab.tsx:286` — `MemberAlertToggle`, the only UI surface: a per-member on/off switch in the project-members tab
- `packages/server/api/test/integration/ce/alerts/alerts-service.test.ts` — service-level integration tests

## Domain Terms
- **AlertChannel** — delivery mechanism; only `EMAIL` exists.
- **Receiver** — the alert's target, stored as a lowercased, trimmed email string (`alerts-service.ts:100`). Not a foreign key to `user`.
- **Alert row** — one `(projectId, receiver)` subscription. Uniqueness is enforced in application code, not by a DB constraint.

## Entity

### `alert` (`AlertEntity`)
| Column | Type | Notes |
|---|---|---|
| id | varchar(21) | ApId |
| created / updated | timestamptz | `BaseColumnSchemaPart` |
| projectId | varchar(21) | **No FK to `project`** — see the sweep below |
| channel | varchar | `AlertChannel` value, stored as a plain string |
| receiver | varchar | normalized (lowercased + trimmed) email |

Index: `idx_alert_project_id` on `projectId`, non-unique. There is **no** unique index on `(projectId, receiver)`; duplicates are prevented only by the `LOWER(receiver)` lookup in `add` (`alerts-service.ts:145-158`), so two concurrent `POST`s can race.

Registered in `getEntities()` at `packages/server/api/src/app/database/database-connection.ts:72`; the module is registered at `packages/server/api/src/app/app.ts:159`.

## Endpoints

All three live under `/v1/alerts` and are `PrincipalType.USER` only — no SERVICE principal, so API keys cannot manage alerts.

| Method | Path | Permission | Project resolved from |
|---|---|---|---|
| GET | `/v1/alerts` | `READ_ALERT` | `ProjectResourceType.QUERY` (`projectId` query param) |
| POST | `/v1/alerts` | `WRITE_ALERT` | `ProjectResourceType.BODY` (`projectId` in body) |
| DELETE | `/v1/alerts/:id` | `WRITE_ALERT` | `ProjectResourceType.TABLE` against `AlertEntity` — the row's own `projectId` is looked up and checked |

`alerts-module.ts:8` also adds a `preSerialization` hook running `entitiesMustBeOwnedByCurrentProject`. `READ_ALERT` / `WRITE_ALERT` are granted to `DefaultProjectRole.ADMIN` (`packages/shared/src/lib/core/authn/access-control-list.ts:19-20`).

## Service Methods

### `alertsService(log)`

- **`add({ projectId, channel, receiver })`** (`alerts-service.ts:97`) — normalizes the receiver to lowercase + trimmed, then branches on project type:
  - `PERSONAL` (`:103`): the receiver must equal the project owner's identity email, else `ErrorCode.VALIDATION`.
  - `TEAM` (`:115`): the email must resolve to a `user_identity` that is `verified`, to a `user` on the project's platform, **and** to a `project_member` row — checked via `projectService#getProjectRoleForUser` (`:132`). There is **no owner exemption**: a TEAM project owner without a `project_member` row is rejected like anyone else. Platform membership alone is deliberately insufficient, because the failure mail leaks project and flow display names (comment at `:128-130`).
  - Duplicate receiver → `ErrorCode.EXISTING_ALERT_CHANNEL`, mapped to HTTP 409 in `helper/error-handler.ts:27`.
  - Cap → `MAX_ALERTS_PER_PROJECT` (20, `alerts-service.ts:209`); exceeding it throws `ErrorCode.VALIDATION`.
  - Returns `void`, so `POST /v1/alerts` has an empty response body even though the web client types it as `Alert` (`web/.../alerts-api.ts:10`).
- **`list({ projectId, cursor, limit })`** (`:183`) — cursor-paginated via `buildPaginator`, ascending, filtered by `projectId`; `limit` defaults to 10.
- **`delete({ alertId })`** (`:199`) — `repo().delete({ id })`. A **hard** delete with no audit record; tenant scoping for this call comes entirely from the controller's `ProjectResourceType.TABLE` check, not from the service.
- **`deleteAllForProject({ projectId, entityManager })`** (`:203`) — hard-deletes every alert of a project, optionally inside a caller-supplied transaction.
- **`sendAlertOnRunFinish(flowRun)`** (`:27`) — see below.

## Send Path (`sendAlertOnRunFinish`)

Called only from `flowRunHooks#onFinish`, wrapped in `tryCatch`, which logs and swallows any error (`flow-run-hooks.ts:15-19`). Order of the guards:

1. **Not a failure** → return (`:28`), via `isFailedState(flowRun.status)`.
2. **`isSmtpConfigured()` guard** (`:31`) — if `SMTP_HOST`/`SMTP_PORT`/`SMTP_USERNAME`/`SMTP_PASSWORD` are not all set (`helper/mail/email-sender/smtp-email-sender.ts:86`), it logs and returns before touching Redis. The web UI mirrors this with the `ApFlagId.SMTP_CONFIGURED` flag, disabling the toggle and showing an explanatory line (`project-members-tab.tsx:89`, `:200-208`).
3. **24h Redis dedup** (`:37-42`) — `INCRBY flow_fail_count:<flowVersionId> 1` followed by `EXPIRE <key> 86400`; if the counter is `> 1` the function returns, so only the first failure per flow **version** mails within the window. Two consequences worth knowing:
   - `EXPIRE` is re-applied on **every** increment, so the 24h window slides forward with each subsequent failure rather than being fixed from the first one.
   - The counter is incremented **before** revalidation and before any send. A transient failure further down (notably the membership lookup in step 5, whose error is deliberately allowed to propagate) still leaves the counter at 1, so that flow version's alerts stay suppressed for the rest of the window.
4. **Load candidates** (`:44`) — `this.list({ projectId, limit: MAX_ALERT_RECEIVERS })` with `MAX_ALERT_RECEIVERS = 50` (`:208`), filtered to `AlertChannel.EMAIL`. Note this 50 sits above the per-project cap of 20, so it is not a practical truncation point today.
5. **Send-time revalidation** (`:58`) — `projectService#filterActiveMemberEmails({ project, emails })`.
6. **Mail** (`:82`) — `emailService#sendFlowIssueAlert` with project name, flow name, run URL (via `domainHelper.getPublicUrl`), and the failed step's number/name/message; `createdAt` is formatted in the hardcoded `America/Los_Angeles` zone (`:89`).

### Why revalidation at send time is necessary
`add`-time membership checking is not sufficient because the `alert` row is keyed by **email**, not `userId`, and nothing deletes it when the person loses access:

- `userService#removeFromPlatform` (`user/user-service.ts:176-194`) offboards a user by setting `user.platformId = null` and rotating the identity's `tokenVersion`. It does **not** delete the `user` row, the `project_member` row, or any `alert` row.
- `project_member` has no FK to `user`, so the membership row survives that update untouched (comment at `project-service.ts:293-297`).

So `filterActiveMemberEmails` treats "still a member" as strictly narrower than "a `project_member` row exists": for TEAM projects it joins `project_member → user → user_identity` and requires `user.platformId` to still equal the project's `platformId` (`project-service.ts:318-329`); for PERSONAL projects, where the owner has no `project_member` row, it requires the caller to still be the owner and still attached to the platform (`:308-316`). Failure of this lookup is intentionally **not** caught inside `sendAlertOnRunFinish` — failing closed costs one missed alert instead of risking mail to an ex-member (comment at `:51-57`).

Receivers dropped by this filter are counted and logged (never the addresses themselves, `:63-70`). A drop is permanent and silent to the user: rows armed before the `add`-time check existed can name someone with real project access but no `project_member` row (e.g. a platform ADMIN/OPERATOR, who bypasses `applyProjectsAccessFilters` entirely), and such a receiver simply stops getting mail.

## Side Effects / Hooks

- **Project soft-delete sweep.** `projectService#softDelete` opens a transaction, marks the project deleted, and calls `projectHooks.get(log).postSoftDelete({ entityManager, projectId })` inside it (`project-service.ts:242-245`). The only implementation is registered from `alerts-module.ts:12-20` and calls `alertsService(log).deleteAllForProject({ projectId, entityManager })`. Two reasons for this shape:
  - It must be **atomic** with the soft delete: `softDelete` uses `deleted IS NULL` semantics for its own lookup, so a partial failure would leave the project unreachable to any retry that would re-run the sweep, with its alert rows orphaned (`project-service.ts:239-241`). Per the repo convention, effects that must commit with the mutation are hooks invoked inside the mutation's transaction, not `*-side-effects.ts` calls from a controller.
  - It is registered from the **alerts** module, not from `project-service`, to avoid a `project → alerts → project` import cycle — `alertsService` itself imports `projectService` (comment at `alerts-module.ts:9-11`).
- **No post-create subscription.** `ProjectPostCreateContext` declares an `alertReceiverEmail` field (`project/project-hooks.ts:18`, mirrored by `shared/src/lib/management/project/project-requests.ts:29`), but the default `projectHooks.postCreate` is a no-op and the implementation registered by `alerts-module.ts:13-15` returns immediately, so creating a project subscribes nobody.

## Limits

| Constant | Value | Where | Effect |
|---|---|---|---|
| `MAX_ALERTS_PER_PROJECT` | 20 | `alerts-service.ts:209` | `add` throws `ErrorCode.VALIDATION` at or above this count |
| `MAX_ALERT_RECEIVERS` | 50 | `alerts-service.ts:208` | page size used when loading receivers on the send path |

Both are module-private constants — not configurable, not exported, and not surfaced to the API.

## Gotchas

- **Hard delete, no audit record.** `delete` and `deleteAllForProject` remove rows outright. There is no `deleted` column and no audit-event persistence anywhere in this repo, so an alert that vanishes leaves no trace of who removed it or when.
- **Email as the identity key.** Changing a user's identity email does not migrate their alert rows; the old address keeps the row and simply fails revalidation.
- **`add` races.** Without a unique DB index on `(projectId, receiver)`, both the duplicate check and the `MAX_ALERTS_PER_PROJECT` count are read-then-write with no lock.
- **Dedup is per flow version, not per flow.** Publishing a new version resets the suppression window for that flow.

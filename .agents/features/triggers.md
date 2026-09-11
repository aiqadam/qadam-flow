# Trigger Module

## Summary
Manages the full lifecycle of flow triggers — registration, event capture, testing, and deduplication. A trigger defines how and when a flow starts: via polling, inbound webhooks, app-native webhooks routed through the shared `app-event-routing` table (`trigger/app-event-routing/`), or manual invocation. The module tracks each enabled trigger as a `TriggerSource` record, maintains deduplication state in Redis, and drives enable/disable side effects such as BullMQ job scheduling and external webhook registration.

## Key Files
- `packages/server/api/src/app/trigger/trigger-source/flow-trigger-side-effect.ts` — enable/disable side effects per strategy
- `packages/server/api/src/app/trigger/trigger-source/trigger-source-service.ts` — TriggerSource CRUD
- `packages/server/api/src/app/trigger/trigger-source/trigger-source-entity.ts` — TriggerSource entity
- `packages/server/api/src/app/trigger/trigger-source/trigger-utils.ts` — helper utilities
- `packages/server/api/src/app/trigger/trigger-events/trigger-event.service.ts` — TriggerEvent storage and retrieval
- `packages/server/api/src/app/trigger/trigger-events/trigger-event-controller.ts` — TriggerEvent endpoints
- `packages/server/api/src/app/trigger/trigger-events/trigger-event.entity.ts` — TriggerEvent entity
- `packages/server/api/src/app/trigger/test-trigger/test-trigger-service.ts` — simulation and test-function modes
- `packages/server/api/src/app/trigger/test-trigger/test-trigger-controller.ts` — test trigger endpoints
- `packages/server/api/src/app/trigger/dedupe-service.ts` — Redis-based deduplication for polling
- `packages/server/api/src/app/trigger/app-event-routing/app-event-routing.service.ts` — APP_WEBHOOK routing table
- `packages/server/api/src/app/trigger/app-event-routing/app-event-routing.entity.ts` — AppEventRouting entity
- `packages/server/api/src/app/trigger/trigger-run/trigger-run-stats.ts` — per-platform trigger health tracking
- `packages/server/api/src/app/trigger/trigger-run/trigger-run.controller.ts` — trigger run stats endpoints
- `packages/server/api/src/app/trigger/trigger.module.ts` — module registration
- `packages/shared/src/lib/automation/trigger/index.ts` — TriggerSource schema, TriggerStrategy enum, WebhookHandshakeConfiguration, ScheduleOptions
- `packages/web/src/app/builder/test-step/test-trigger-section/index.tsx` — test panel in the builder sidebar
- `packages/web/src/app/builder/test-step/test-trigger-section/first-time-testing-section.tsx` — initial test prompt before any event is captured
- `packages/web/src/app/builder/test-step/test-trigger-section/simulation-section.tsx` — simulation status UI
- `packages/web/src/app/builder/test-step/test-trigger-section/trigger-event-select.tsx` — event selector from previously captured events
- `packages/web/src/app/builder/test-step/test-trigger-section/manual-webhook-test-button.tsx` — button to send a test HTTP request to the webhook endpoint
- `packages/web/src/app/builder/test-step/custom-test-step/test-webhook-dialog.tsx` — dialog for manually testing webhook triggers
- `packages/web/src/app/builder/flow-canvas/nodes/step-node/trigger-widget.tsx` — trigger node widget on the flow canvas
- `packages/web/src/app/builder/flow-canvas/widgets/above-trigger-button.tsx` — "+ Add trigger" button above the trigger node

## Domain Terms
- **TriggerStrategy** — execution model: `POLLING`, `WEBHOOK`, `APP_WEBHOOK`, `MANUAL`
- **TriggerSource** — the persisted record linking a flow version to its registered trigger; soft-deleted on disable; unique per (projectId, flowId, simulate)
- **TriggerEvent** — a captured payload from a trigger execution, stored as a File reference; used for test data selection in the builder
- **AppEventRouting** — routing table for APP_WEBHOOK: maps (appName, event, identifierValue) to a flow
- **simulate flag** — TriggerSource with `simulate=true` is a test-mode source; production and test sources coexist independently
- **Deduplication** — Redis INCR check on `__DEDUPE_KEY_PROPERTY` prevents duplicate payloads from polling triggers
- **Renewal job** — BullMQ repeating job that calls ON_RENEW hook for webhook pieces that need periodic re-registration (e.g., expiring webhooks)
- **sourceName** — format `pieceName@version:triggerName`; used as a stable identifier for TriggerEvents

## Entities

**TriggerSource**: id, flowId, flowVersionId, projectId, type (TriggerStrategy), pieceName, pieceVersion, triggerName, simulate (boolean — true for test triggers), schedule (JSONB for polling cron). Unique on (projectId, flowId, simulate) with soft delete filter.

**TriggerEvent**: id, flowId, projectId, sourceName (format: `pieceName@version:triggerName`), fileId (FK to File storing serialized payload).

**AppEventRouting**: id, appName, event, identifierValue (org/account ID), flowId, projectId. Unique on (appName, projectId, flowId, identifierValue, event).

## Trigger Strategies

- **POLLING**: Periodic checks via cron schedule. BullMQ repeating job. Deduplication via Redis.
- **WEBHOOK**: External service pushes events to Activepieces webhook URL.
- **APP_WEBHOOK**: App-native webhooks routed via AppEventRouting (e.g., Slack, GitHub).
- **MANUAL**: User-triggered only, no automation.

## Enable/Disable Side Effects

**On enable** (`flowTriggerSideEffect.enable()`):
- POLLING: Creates BullMQ repeating job with cron from piece or default interval (`AP_TRIGGER_DEFAULT_POLL_INTERVAL`)
- WEBHOOK: Submits ON_ENABLE hook to worker (registers webhook with external service). If piece has renewConfiguration with CRON strategy, creates renewal job.
- APP_WEBHOOK: Creates AppEventRouting records for each event type
- MANUAL: No side effects

**On disable** (`flowTriggerSideEffect.disable()`):
- Removes BullMQ repeating jobs
- Submits ON_DISABLE hook to worker (unregisters webhook)
- Deletes AppEventRouting records

## Long-polling host (`trigger/long-polling/`, off by default)

An alternative *delivery source* for WEBHOOK triggers, for instances the third party cannot reach.
The trigger stays `TriggerStrategy.WEBHOOK`; only where the payload comes from changes.

- Gated by `AP_TRIGGER_LONG_POLLING_ENABLED` (default `false`), and started from `appPostBoot`.
- `event-puller-registry.ts` maps a qadam name to a `QadamEventPuller` (`@aiqadam/qadams-framework`).
  The qadam owns the protocol — endpoint, window length, cursor arithmetic, fatal/retryable
  classification — and whether a given trigger config wants pulling (`isEnabledFor`). Core never
  reads a third-party prop name.
- `long-polling-source.ts` lists live, non-simulate trigger sources for registered qadams whose flow
  is ENABLED, resolves each to one credential, and keeps one task **per credential** (last flow
  enabled wins, mirroring `setWebhook`'s last-writer-wins).
- `long-polling-host.ts` runs the loop. The lock and the cursor are keyed on the puller's
  `credentialKey({ auth })` — for Telegram the bot id, which is the unit the third party counts as
  one consumer — so two *connections* holding one bot token cannot poll each other's updates away.
  The cursor in `distributedStore` advances **only after** a successful `webhookService.handleWebhook`.
  Retryable failures back off exponentially, with `retryAfterSeconds` applied as a floor above the
  ceiling; a fatal verdict stops the task until the flow is disabled and re-enabled (the mark is
  keyed on the trigger-source row, which `enable` always rewrites).
  A connection that cannot be *read* right now is explicitly not fatal — only one that is deleted,
  in ERROR, or belongs to another qadam.
  Qadam code runs in-process unsandboxed, so every call into a puller is `tryCatch`-wrapped,
  time-boxed above the qadam's own window, paced by `MIN_WINDOW_INTERVAL_MS` so a puller that
  returns instantly cannot spin the event loop, and handed nothing but `auth`, the trigger's
  `settings.input` and an `AbortSignal`. The registry is loaded lazily, so an instance with the flag
  off never evaluates a community qadam at all.
- Reconciled by `triggerSourceService.enable`/`disable` (immediate) plus a 60s per-instance
  interval (backstop). Not a system job: those run on one instance cluster-wide, while every
  instance needs its own view of which tasks it is running.
- `triggerSourceService.enable` refuses a pull-transport trigger while the flag is off, before the
  engine's ON_ENABLE hook removes the webhook — otherwise the flow would end up with no delivery.
- Metrics: `qadam_flow.long_polling.tasks` and `qadam_flow.long_polling.event_loop_delay_ms`.
- `instrumentation.ts` redacts credential-shaped URL paths (`/bot<id>:<secret>`) from `url.full` /
  `http.url` span attributes, since Telegram carries the token in the path and the HTTP
  auto-instrumentation records whole URLs.

## Deduplication (`dedupeService`)

For polling triggers — prevents duplicate payloads:
- Extracts `__DEDUPE_KEY_PROPERTY` from each payload
- Redis INCR with 30s TTL: first occurrence passes, duplicates filtered
- Removes dedupe key from returned payloads

## Testing

**Two modes** via `testTriggerService`:
- **SIMULATION**: Creates test TriggerSource (simulate=true), enables it, collects events
- **TEST_FUNCTION**: Submits TEST hook job to worker, saves outputs as TriggerEvents
- Uses distributed lock to prevent concurrent test runs

## Trigger Health

`triggerRunStats` tracks per-platform success/failure rates:
- Redis key: `trigger_run:{platformId}:{pieceName}:{date}:{status}`
- 14-day retention. Displayed in Platform Admin → Infrastructure → Triggers.
- `GET /v1/trigger-runs/status` is `securityAccess.platformAdminOnly([USER])`. It was
  `publicPlatform` until #270 — a principal-*type* check only, so the platform-wide report was
  readable by any authenticated platform user (embedded JWT users included) while the only UI that
  renders it sits behind `useIsPlatformAdmin()`.

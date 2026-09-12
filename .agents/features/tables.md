# Tables Module

## Summary
A built-in relational database feature that lets users store structured data directly within Activepieces, without needing an external database. Tables support typed fields, cell-level storage, per-row webhooks that fire flow automations, and a rich spreadsheet-like editor in the UI. They are tightly integrated with the flow engine through the Tables piece, which provides trigger and action steps for reacting to and manipulating table data.

## Key Files
- `packages/server/api/src/app/tables/table/table.service.ts` — table CRUD, export, webhook management
- `packages/server/api/src/app/tables/table/table.controller.ts` — table endpoints
- `packages/server/api/src/app/tables/table/table.entity.ts` — Table entity
- `packages/server/api/src/app/tables/table/table-webhook.entity.ts` — TableWebhook entity
- `packages/server/api/src/app/tables/field/field.service.ts` — field CRUD
- `packages/server/api/src/app/tables/field/field.controller.ts` — field endpoints
- `packages/server/api/src/app/tables/field/field.entity.ts` — Field entity
- `packages/server/api/src/app/tables/record/record.service.ts` — record CRUD, bulk ops
- `packages/server/api/src/app/tables/record/record.controller.ts` — record endpoints
- `packages/server/api/src/app/tables/record/record.entity.ts` — Record entity
- `packages/server/api/src/app/tables/record/cell.entity.ts` — Cell entity
- `packages/server/api/src/app/tables/record/record-filter.ts` — compiles a `Filter[]` into JS matchers, plus the SQL predicate for each operator the database can reproduce exactly
- `packages/server/api/src/app/tables/record/record-query.ts` — builds the record query, pushing those predicates down as `EXISTS` sub-queries
- `packages/server/api/src/app/tables/record/record-side-effects.ts` — fires TableWebhook flows on record events
- `packages/qadams/core/tables/src/lib/common/index.ts` — the Tables qadam's server calls; resolves a table id and its field schema once per run (`memoisePerRun`), since every action otherwise pays two HTTP round-trips before its own request
- `packages/server/api/src/app/tables/tables.module.ts` — module registration
- `packages/shared/src/lib/automation/tables/table.ts` — Table schema
- `packages/shared/src/lib/automation/tables/field.ts` — Field schema and FieldType enum
- `packages/shared/src/lib/automation/tables/record.ts` — Record schema
- `packages/shared/src/lib/automation/tables/cell.ts` — Cell schema
- `packages/shared/src/lib/automation/tables/table-webhook.ts` — TableWebhook schema
- `packages/shared/src/lib/automation/tables/dto/` — request/response DTOs
- `packages/web/src/app/routes/tables/id/index.tsx` — the table editor page (react-data-grid based)
- `packages/web/src/features/tables/components/ap-table-header.tsx` — header bar with table name, actions
- `packages/web/src/features/tables/components/ap-table-state-provider.tsx` — state context for the table
- `packages/web/src/features/tables/components/ap-field-header.tsx` — column header with field actions
- `packages/web/src/features/tables/components/table-columns.tsx` — column definitions for react-data-grid
- `packages/web/src/features/tables/components/editable-cell.tsx` — cell editing wrapper
- `packages/web/src/features/tables/components/ap-table-actions-menu.tsx` — table-level action menu
- `packages/web/src/features/tables/components/import-table-dialog.tsx` — CSV import dialog
- `packages/web/src/features/tables/components/new-field-popup.tsx` — add field popup
- `packages/web/src/features/tables/hooks/table-hooks.ts` — React Query hooks for tables/fields/records
- `packages/web/src/features/tables/stores/store/ap-tables-client-state.tsx` — optimistic client-side state
- `packages/web/src/features/tables/stores/store/ap-tables-server-state.ts` — server-synced state
- `packages/web/src/features/tables/api/tables-api.ts` — table API calls
- `packages/web/src/features/tables/api/fields-api.ts` — field API calls
- `packages/web/src/features/tables/api/records-api.ts` — record API calls

## Domain Terms
- **Table** — a named collection of typed columns (fields) and rows (records), scoped to a project
- **Field** — a typed column definition; types: `TEXT`, `NUMBER`, `DATE`, `STATIC_DROPDOWN`
- **Record** — a single row in a table; stored as a row entity with associated cells
- **Cell** — one value at the intersection of a record and a field (stored as VARCHAR)
- **TableWebhook** — a link between a table event and a flow; fires the flow when the event occurs
- **Table events** — `RECORD_CREATED`, `RECORD_UPDATED`, `RECORD_DELETED`
- **externalId** — a stable external identifier for tables and fields, used by the flow integration layer
- **Tables piece** — `packages/qadams/core/tables/`; provides trigger and action steps that interact with tables via the internal API

## Data Model

**Table**: id, projectId, name, folderId (nullable), externalId, trigger (nullable), status (nullable). Relations: project, folder, fields[], records[], tableWebhooks[].

**Field**: id, tableId, projectId, name, type, externalId, data (JSONB — e.g., `{ options: [{ value }] }` for STATIC_DROPDOWN).
- **FieldType**: `TEXT`, `NUMBER`, `DATE`, `STATIC_DROPDOWN`
- System limit: `AP_MAX_FIELDS_PER_TABLE` (default 100)

**Record**: id, tableId, projectId. Relations: table, cells[].

**Cell**: id, recordId, fieldId, projectId, value (VARCHAR). Unique constraint: (projectId, fieldId, recordId).

**TableWebhook**: id, projectId, tableId, flowId, events[] (string array).
- **Events**: `RECORD_CREATED`, `RECORD_UPDATED`, `RECORD_DELETED`

## Key Service Methods

- `table.create()` — creates table + optional fields
- `table.list()` — paginated with optional row count, name filter, single-folder filter (`folderId`), multi-folder filter (`folderIds`), externalIds filter
- `table.update()` — rename, move to folder, change trigger/status
- `table.delete()` — cascades to fields, records, cells, webhooks
- `table.exportTable()` — returns fields + rows as JSON
- `table.createWebhook()` / `table.deleteWebhook()` — link table events to flows
- `record.create()` — bulk insert (max 50 per batch, transactional), validates field count
- `record.list()` — with filters (EQ, NEQ, GT, GTE, LT, LTE, CO, IN, NOT_IN, EXISTS, NOT_EXISTS). A filter naming a field that is not a column of the table is **rejected** (`ErrorCode.VALIDATION`), not dropped — dropping it read as "no filter" and returned the whole table (#382).
- `record.list()` / `record.getById()` — optional `fieldIds` projection. The cell query covers projected **∪ filtered** columns, never just the projection: a filter whose column was not fetched finds no cell, which the missing-cell guard reads as a match for NOT_EXISTS — the whole table. A `fieldIds` entry that is not a column of the table is rejected (`ErrorCode.VALIDATION`), never dropped.
- `record.list()` — EQ, NEQ, IN, NOT_IN, EXISTS and NOT_EXISTS are evaluated by Postgres as `EXISTS (SELECT 1 FROM cell …)` sub-queries (`record-query.ts`), so a keyed lookup no longer loads every record and cell of the table. CO and the four ordering operators are **not** pushed down — `toLowerCase`/`Intl.Collator` and the database's collation disagree — and the JS matcher in `record-filter.ts` still runs over whatever comes back and remains the authority on what matches; SQL only ever removes rows it would have rejected. `LIMIT` moves into SQL only when every filter was pushed down, otherwise the JS pass would be handed a short page. Guarded by a differential test (`test/integration/ce/tables/record-filter-pushdown.test.ts`) that compares each operator's endpoint result against the JS-only result over adversarial values.
- `record.list()` — optional `recordIds` pushes an id restriction into SQL (served by `idx_record_table_id_project_id_record_id`) instead of materialising the table; the controller defaults `limit` to the id count so a lookup is not truncated to `DEFAULT_PAGE_SIZE`
- `record.upsert()` — `POST /v1/records/upsert`. Matches on a declared key column set and inserts or updates, reporting which happened per row. Serialised by `pg_advisory_xact_lock` keyed on the table, taken **inside** the transaction — a Postgres transaction-scoped lock rather than the Redis `distributedLock`, because it cannot expire before the insert it guards commits, and under `REDIS_TYPE=MEMORY` the Redis one is per-process. There is no declared unique index to arbitrate on yet (#409). An absent cell and an empty cell are the same key value.
- `record.update()` — update cells (empty fields unchanged). Optional `precondition` (an array of `Filter`) makes it compare-and-set: evaluated under a `pessimistic_write` row lock inside the same transaction as the write, raising `RECORD_PRECONDITION_FAILED` (409) rather than silently writing nothing. The row lock is taken unconditionally, so a plain concurrent update cannot clobber between a conditional update's check and its write.
- `record.updateMany()` — `POST /v1/records/batch`. One transaction, one field lookup and one cell upsert per chunk for the whole batch. Every id is checked against the requested `tableId`; a miss rolls the batch back. A repeated record id, or the same column twice in one record, is rejected before the upsert — Postgres would otherwise raise "cannot affect row a second time" as a 500. Does **not** call `validateCount`: an update creates no rows.
- `record.delete()` / `record.deleteAll()` — bulk delete

## Access Control

All table / field / record routes use `securityAccess.project([...], <permission>, <resource>)`. The required permission per resource:

- **Read** (`GET /v1/tables`, `GET /v1/tables/:id`, `GET /v1/fields`, `GET /v1/fields/:id`, `GET /v1/records`, `GET /v1/records/:id`): `READ_TABLE`
- **Write** (`POST /v1/records/batch`, `POST /v1/records/upsert`, `POST /v1/tables`, `POST /v1/tables/:id`, `DELETE /v1/tables/:id`, `POST /v1/fields`, `POST /v1/fields/:id`, `DELETE /v1/fields/:id`, `POST /v1/records`, `POST /v1/records/:id`, `DELETE /v1/records`): `WRITE_TABLE`

Default project roles: `ADMIN` and `EDITOR` have both; `VIEWER` has only `READ_TABLE`. Custom roles inherit whatever permissions are configured.

`ENGINE` and `SERVICE` principals skip the per-role permission check entirely — `ENGINE` is gated on `principal.projectId === projectId` and `SERVICE` on platform-equality only — so flow steps that call the records API and service API keys are unaffected by the role-permission model.

When adding a new route (read or write) on tables / fields / records, the `permission` argument to `securityAccess.project(...)` is required; passing `undefined` short-circuits the rbac check to allow any project member.

## Side Effects

After record create/update/delete, `recordSideEffects.handleRecordsEvent()`:
1. Finds TableWebhooks matching the event type
2. For each matching webhook, triggers the linked flow via webhook service
3. Passes record data as payload

## Table → Flow Integration

Tables piece (`packages/qadams/core/tables/`) provides:
- **Triggers**: New Record, Record Updated, Record Deleted (register TableWebhook on enable, delete on disable)
- **Actions**: Create Record(s), Get Record, Find Records, Update Record, Delete Record(s), Clear Table
- Uses internal API with Bearer token authentication

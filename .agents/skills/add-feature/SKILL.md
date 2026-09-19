---
name: add-feature
description: "Use when the user asks to add a feature, implement functionality, or build something spanning database, API, and frontend. ALWAYS use for multi-layer feature work."
---

# Add Feature End-to-End

Implement feature described in $ARGUMENTS across the full stack.

## Step 0: Check it does not already exist

Run the `ubiquitous-language` skill's overlap detection against `.agents/features/` **before**
proposing anything. A feature that duplicates an existing one is the most expensive thing you
can ship here, and the registry exists to catch it in a minute.

Then answer, before writing code:

1. **Does a narrower skill own a step of this?** `add-entity`, `add-endpoint` and
   `db-migration` are the authority on their own steps — this skill sequences them, it does
   not replace them. Read each one when you reach its step.
2. **Project-scoped or platform-scoped?** → every query filters by `projectId` or
   `platformId` accordingly (`.agents/rules/data-isolation.md`).
3. **Need a Permission?** → add to the `Permission` enum in
   `packages/shared/src/lib/core/common/security/permission.ts`.
4. **Must work embedded?** → check `EmbeddingState` in the frontend.
5. **No edition gating, ever.** All features are available to all users; there is no EE tree,
   no paywall and no plan flag to hide behind (`.agents/rules/edition-safety.md`).

## Step 1: Shared Types (`packages/shared`)

- Define Zod schemas + `z.infer` types in `src/lib/{domain}/`
- Export from `src/index.ts` barrel
- Bump version in `package.json` (patch for fix, minor for new export)

## Step 2: Server (`packages/server/api`)

Read `.agents/features/<module-name>.md` first (e.g. `.agents/features/tables.md` for the tables module).

- **Entity**: follow the `add-entity` skill. Short version: `EntitySchema` + `BaseColumnSchemaPart` + `ApIdSchema`, see `tables/table/table.entity.ts`.
- **Register entity**: add to `getEntities()` in `database-connection.ts` (REQUIRED — TypeORM doesn't auto-discover)
- **Migration**: follow the `db-migration` skill — it is mandatory, not a reference.
- **Service**: Factory `(log: FastifyBaseLogger) => ({...})` if logging needed, plain object otherwise. See `tables/table/table.service.ts`.
- **Controller**: follow the `add-endpoint` skill. `FastifyPluginAsyncZod`, route configs AFTER the controller, `securityAccess` required. See `tables/table/table.controller.ts`.
- **Project ownership**: Add `entitiesMustBeOwnedByCurrentProject` hook if returning project-scoped data
- **Module**: register it in `app.ts` alongside the existing modules — there is no CE/EE split to place it in
- **Side effects**: Separate `*-side-effects.ts` file if mutations trigger events/webhooks

## Step 3: Worker (if queued work needed)

- Add to `SystemJobName` or `WorkerJobType` enum in shared
- Add handler, register in `app.ts` via `systemJobHandlers.registerJobHandler()`

## Step 4: Frontend (`packages/web`)

- Read the `design` skill first — any new surface follows it
- Feature folder: `src/features/{feature}/api/`, `hooks/`, `components/`
- API client: See `features/tables/api/tables-api.ts`
- Hooks: See `features/tables/hooks/table-hooks.ts`
- Route: `React.lazy()` + `ProjectRouterWrapper()` + `RoutePermissionGuard` + `SuspenseWrapper`
- Translations: `en` plus `ru`/`uz`/`kk` in the same PR (`npm run check-i18n` enforces parity)
- Feature flags: `flagsHooks.useFlag()` or `<FlagGuard>`

## Step 5: Tests

- API test: `packages/server/api/test/integration/ce/{feature}.test.ts`
- Use `setupTestEnvironment()` + `createTestContext(app)`

## Step 6: Verify, then get it reviewed

```bash
npm run lint-dev
npm run typecheck     # required once you touched packages/web — vite build does not type-check
npm run check-i18n    # required once you touched translations
npm run test-api
```

Then delegate `code-quality` and `app-sec` per `.agents/rules/agent-delegation.md`, before
you report the feature done. A multi-layer feature is exactly the shape of change both
reviewers exist for.

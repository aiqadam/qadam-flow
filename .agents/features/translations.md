# Translations

## Summary
Flow translations are project-scoped key/locale/value triples that a flow can look up at run time via `{{$t['key']}}`, optionally with a dynamic locale (`{{$t['key'][<expr>]}}`). Modelled on `variables` (new feature, not an extension of it — confirmed by the ubiquitous-language overlap check on #420) but with its own storage shape: a `values` jsonb column keyed by BCP-47 locale rather than a single encrypted scalar, since a translation is public data, not a secret. Phase 1 (this doc) covers backend storage, the engine's `$t` resolver, MCP tools and static validation; the builder UI (grid page, import/export, data-selector `$t` chip, `localeSource` setting) is a follow-up phase.

## Key Files
- `packages/server/api/src/app/translation/translation.entity.ts` — TypeORM entity (`translation` table, unique `(projectId, key)` index).
- `packages/server/api/src/app/translation/translation.service.ts` — list / batch upsert (merge-by-`jsonb ||`) / delete / import (merge or replace-one-locale) / export.
- `packages/server/api/src/app/translation/translation.controller.ts` — `/v1/translations` REST routes (USER + SERVICE).
- `packages/server/api/src/app/translation/translation-worker.controller.ts` — `/v1/worker/translations` engine-only route; project-scoped explicitly in the service call, not via `entitiesMustBeOwnedByCurrentProject` (the `{ translations: [...] }` map shape bypasses that hook).
- `packages/server/api/src/app/translation/translation.module.ts` — Fastify module wrapper.
- `packages/server/api/src/app/database/migration/postgres/1790500000000-AddTranslationTable.ts`, `1790600000000-AddProjectDefaultLocale.ts`, `1790700000000-AddFlowVersionLocaleSource.ts`, `1790800000000-BackfillTranslationPermissionsOnDefaultRoles.ts` (idempotent: appends `READ_TRANSLATION`/`WRITE_TRANSLATION` to the Admin/Editor/Viewer default roles for installs that predate this feature), `1790900000000-AddInheritedRunLocaleToFlowRun.ts` — schema migrations.
- `packages/shared/src/lib/automation/translation/translation.ts` — `Translation` schema, `TRANSLATION_KEY_REGEX`, caps, and `localeUtil` (canonicalization + the one candidate-chain builder used by both the engine and the validator).
- `packages/shared/src/lib/automation/translation/dto/*.ts` — request/response schemas (batch upsert, list, import, export).
- `packages/shared/src/lib/automation/translation/translation-token.ts` — parses the `$t['key'][expr]` grammar (`parseTranslationToken`), shared by the engine's `props-resolver.ts` and the API's `ap_validate_flow`/`translation.service.ts` (usages lookup) so all three accept and reject exactly the same tokens.
- `packages/server/engine/src/lib/variables/props-resolver.ts` — the `$t` branch in `resolveSingleToken` / `handleTranslation`; resolves via the shared `localeUtil.resolve` (`Map`-based) rather than its own duplicate.
- `packages/server/engine/src/lib/qadam-context/translation-resolver.ts` — HTTP fetch of the whole project translation table, mirrors `variable-resolver.ts`.
- `packages/server/engine/src/lib/handler/context/engine-constants.ts` — `getTranslations()` and `getRunLocale()`, both promise-memoized (in-flight, not just resolved-value) so concurrent `$t` resolutions in the same run share one fetch/one evaluation rather than one each. `getRunLocale({ executionState })` evaluates `flowVersionLocaleSource` as a normal template (via `resolveInputAsync`, the same path every other step input goes through — not raw JS) against the CALLER's own `executionState`, exactly once, falling back to `inheritedRunLocale`; a reentrancy sentinel (`isResolvingRunLocale`) makes a `$t` nested inside `localeSource` see "no run locale yet" instead of recursing.
- `packages/server/engine/src/lib/handler/qadam-executor.ts` — `context.run.locale` is a lazy hook (`() => constants.getRunLocale({ executionState })`, called only if a qadam actually reads it), not a value computed eagerly for every action.
- `packages/server/engine/src/lib/handler/inline-flow-executor.ts` — passes the parent's resolved run locale into an inline `callFlow` child's `EngineConstants` directly (in-process, no wire format), resolved against the parent's real, in-flight `executionState` (threaded through from `qadam-executor.ts`), not an empty one.
- `packages/server/api/src/app/mcp/tools/{ap-list-translations,ap-upsert-translations,ap-delete-translation}.ts` — MCP tools; `packages/server/api/src/app/mcp/tools/ap-validate-flow.ts` — `translation_key` (error), `translation_default_locale` (error — key has no value for the project's own default locale), `translation_locale` (warning) categories.
- `packages/server/api/src/app/translation/translation.service.ts`'s `usages()` — `GET /v1/translations/:id/usages`, scans the project's flows (draft and published versions independently, bounded by `MAX_TRANSLATION_USAGE_FLOWS_SCANNED`) for a reference to a key, ahead of deleting it.

## Permissions
- `READ_TRANSLATION` — list, export, MCP list tool, `$t` resolution's read path. Granted to VIEWER, EDITOR, ADMIN.
- `WRITE_TRANSLATION` — batch upsert, delete, import. Granted to EDITOR and ADMIN; VIEWER cannot mutate.

## Domain Terms
- **Translation**: a project-scoped `key` with a `values` map from BCP-47 locale to string.
- **key**: dot-separated segments, `^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$`, ≤255 chars. Enforced at write and at resolve time.
- **locale**: canonicalised via `Intl.getCanonicalLocales` (wrapped — a RangeError on a malformed tag means "not a locale", never an engine crash). Not restricted to the UI's four locales (`en`/`ru`/`uz`/`kk`, `LocalesEnum`) — a translation locale is free BCP-47.
- **Resolution chain** (`localeUtil.buildCandidateChain`, one function, used by both the engine and the validator): explicit locale (from the `$t[...][expr]` bracket) → run locale (`FlowVersion.localeSource`, or inherited from a parent subflow) → project `defaultLocale`; each step also tries its base language (`ru-RU` → `ru`).
- **run locale**: resolved once per run, lazily, memoized on `EngineConstants`. Own `localeSource` wins over an inherited parent locale.
- **`$t` root**: the mention syntax's third context root, beside `variables` and `connections`. No step may be named `$t` (the grammar requires the literal `$t[` prefix, so a step literally named `t` is unaffected — `{{t['output']...}}` still resolves as a normal step reference).

## Entity

**Translation**: id, created, updated, projectId, platformId, key, values (jsonb, `Record<locale, string>`), description (nullable). Unique index `(projectId, key)`.

**Project.defaultLocale** (nullable string) and **FlowVersion.localeSource** (nullable string, versioned like every other flow-version field) are columns on existing entities, not new tables.

**FlowRun.inheritedRunLocale** (nullable string): the locale a queued subflow run inherited from its parent at dispatch time, persisted so a resume or a retry re-dispatches with the same value rather than losing it (a plain in-memory job field would not survive either).

## Endpoints

All mount under `/v1/translations`, project-scoped via `projectId` in the body/query/`:id` lookup.

| Method | Path | Auth | Permission | Description |
|---|---|---|---|---|
| GET | `/v1/translations` | USER + SERVICE | `READ_TRANSLATION` | Paginated list, filterable by a `key` substring. |
| POST | `/v1/translations` | USER + SERVICE | `WRITE_TRANSLATION` | Batch upsert-by-key. Writes merge via `values = values \|\| $1::jsonb` (no read-modify-write) — locales omitted from the request are left untouched. |
| DELETE | `/v1/translations/:id` | USER + SERVICE | `WRITE_TRANSLATION` | Hard delete. |
| POST | `/v1/translations/import` | USER + SERVICE | `WRITE_TRANSLATION` | `{ locale, format: 'flat'\|'nested', mode: 'merge'\|'replace', data }`. `replace` removes that one locale's entries from every key *not* present in the payload — never another locale, never the whole row. Whole write runs in one transaction behind a per-project `pg_advisory_xact_lock`; request body capped at `MAX_TRANSLATION_IMPORT_BYTES` (1 MB), and the route carries its own rate limit (`API_RATE_LIMIT_AUTHN_MAX`/`_WINDOW`). |
| GET | `/v1/translations/export` | USER + SERVICE | `READ_TRANSLATION` | `?locale=&format=` (defaults to `flat`) — `{"a.b": "value"}` or `{"a": {"b": "value"}}`. |
| GET | `/v1/translations/:id/usages` | USER + SERVICE | `READ_TRANSLATION` | Flows in the project whose draft and/or published version reference the key, each reported independently. Bounded by `MAX_TRANSLATION_USAGE_FLOWS_SCANNED`; `truncated: true` if either scan hit the cap. |

Worker route (engine-only, via engine principal token):

| Method | Path | Description |
|---|---|---|
| GET | `/v1/worker/translations` | Returns the whole project translation table as `{ translations: [{ key, values }] }`. Called once per run by the engine, on the first `$t` it resolves. |

## MCP Tools

`packages/server/api/src/app/mcp/tools/{ap-list-translations,ap-upsert-translations,ap-delete-translation}.ts` (all controllable — see `mcp.md`):

- `ap_list_translations` — `READ_TRANSLATION`, read-only, ungated for chat (same reasoning as `ap_list_variables`: nothing here is secret, and the underlying data is already reachable via other ungated tools' output).
- `ap_upsert_translations` — `WRITE_TRANSLATION`, batch. Merges into existing locales, same semantics as the REST endpoint. Gated for chat (changes what a published flow's `$t` references render as, with no value to restore from — same rationale as `ap_upsert_variable`).
- `ap_delete_translation` — `WRITE_TRANSLATION`, destructive. Accepts `key` (exact match) or `id`.

## Engine Resolution

`resolveSingleToken` checks the `$t` prefix after `variables` and `connections`. The branch (`handleTranslation` in `props-resolver.ts`):

1. Parses `$t['key']` optionally followed by exactly one balanced `[<expr>]` bracket (shared `parseTranslationToken`) — anything else (a second bracket, a trailing `.field`) fails to parse and throws `UnresolvedTemplateReferenceError`, the same as an unparseable `variables`/`connections` reference.
2. If a locale bracket is present, evaluates its expression via the shared `evalInScope` against the current step scope, with `unresolvedReference` set — a step name that does not exist in the flow still throws loudly; a resolvable-but-useless result (nil, empty, non-string, non-canonical) falls through to the next link in the chain.
3. Fetches (or reuses the memoized) whole-project translation table, run locale and project default locale, builds the candidate chain, and looks the key up against it in order (`localeUtil.resolve`, `Map`-based, shared with anywhere else resolving a translation value against a chain).
4. The key not existing at all, or existing but having no value anywhere in the chain (which always ends at the project default locale), fails the step with `TranslationKeyNotFoundError` (USER error, mirrors `VariableNotFoundError`).
5. A fallback to a less-specific locale (base language, or the next link in the chain) logs one warning per `(key, requestedLocale)` per run — there is no per-step warnings channel on `FlowExecutorContext` today, so this uses the engine log (`console.warn`), the same fallback `evalInScope`'s own internal error path already uses.
6. Values are inserted literally and never re-scanned for `{{…}}` — a value containing `{{connections['x'].access_token}}` renders verbatim. Unlike `variables`/`connections`, a translation value is not a secret, so the censored pass resolves it the same way the uncensored one does (no `**REDACTED**` branch).

`EngineConstants` holds the memoized state: `getTranslations()` (a `Map<key, Map<locale, value>>` — `Map` throughout, never a plain object, so a key or locale literally equal to `__proto__`/`constructor` is an ordinary entry, never a prototype lookup) and `getRunLocale({ executionState })` (evaluates `flowVersionLocaleSource` once, lazily, through the normal `resolveInputAsync` template path — see `FlowVersion.localeSource` below — falling back to `inheritedRunLocale` on any failure). Both memoize the in-flight PROMISE, not just the resolved value, and clear it on rejection — concurrent `$t` resolutions in the same run share one fetch/one evaluation rather than issuing one each. `getRunLocale` additionally sets a reentrancy sentinel while it evaluates `localeSource`, so a `$t` nested inside `localeSource` itself sees "no run locale yet" (falls through to the default-locale chain) rather than awaiting a promise that depends on itself.

### Subflow locale propagation

Both execution modes pass the parent's resolved run locale to the child; a subflow never has to resolve its own `localeSource` from scratch if the parent already settled on one.

- **Inline `callFlow`** (`inline-flow-executor.ts`): the parent's resolved run locale is read via `parentConstants.getRunLocale({ executionState })`, using the parent's real, in-flight execution state — threaded through from `qadam-executor.ts`'s own step context, which has it in scope at the `context.run.callFlowInline` call site — and passed as a plain field into the child's `EngineConstants` — no wire format needed, same process. A `localeSource` referencing an earlier step's output resolves correctly as long as that step already ran before the inline `callFlow` step, the same guarantee the queued path gets from `context.run.locale`'s own laziness.
- **Queued `callFlow` and `callFlowForEach`**: `context.run.locale` (a lazy hook on `packages/qadams/framework`'s `RunContext` — `() => Promise<string | null>`, resolved only if a qadam actually calls it, using THIS step's own `executionState`, never computed eagerly for every action) is forwarded by every queue-dispatch path in `packages/qadams/core/subflows` — `call-flow.ts`'s single `callFlow` and `call-flow-for-each.ts`'s per-item `dispatchChild` alike — as the `PARENT_RUN_LOCALE_HEADER` header, omitted entirely when `null`. Consumer side: `webhook-request-converter.ts` (canonicalizes and length-caps the incoming header via `localeUtil.canonicalize` before it goes anywhere near the run — an external caller of the same public webhook endpoint can set this header too, harmless as a lookup preference once sanitized) → `webhook.service.ts` → `flow-run-service.ts` (`start`/`addToQueue`) → `ExecuteFlowJobData.inheritedRunLocale` / `WebhookJobData.inheritedRunLocale` → `execute-flow.ts` / `execute-webhook.ts` (worker) → `BeginExecuteFlowOperation.inheritedRunLocale` → `EngineConstants`. Persisted on `flow_run.inheritedRunLocale` (nullable column) so a resume or a retry re-dispatches with the same inherited locale rather than losing it.

## `FlowVersion.localeSource`

A nullable, versioned string field (present in `FlowVersionTemplate`/`SharedTemplate` for free, since it derives from `FlowVersion` via `.omit()`). It is a normal mention-capable template field — the same `{{...}}` syntax and the same mention-capable text input as every other step input, resolved through the exact same `resolveInputAsync` path (a single whole-string token, e.g. `{{trigger['output'].message.from.language_code}}`, returns its raw resolved value; a bare literal with no braces, e.g. `ru`, passes through unchanged and means a fixed locale). Resolved uncensored, once per run, lazily. An evaluation error or a resolvable-but-unusable result (non-string, empty, non-canonical) falls back to the inherited/default locale plus one warning, and never fails the run. Set via `FlowOperationType.UPDATE_LOCALE_SOURCE` (only emitted by `IMPORT_FLOW`/`_importFlow` when the request's `localeSource` is explicitly present — an omitted field never wipes an existing value); carried by `IMPORT_FLOW`, `ap_build_flow`'s optional `localeSource` input, `ap_import_flow`, "use as draft", `ap_duplicate_flow`, and every web duplicate-flow path. No `FlowVersion.schemaVersion` bump: unlike the v21 step-output-nesting migration, this is a new independent field with a natural `null` default — existing content needs no rewriting.

Only the dynamic-locale bracket inside `$t['key'][expr]` stays raw JS (`evalInScope`) — it already sits inside a mention, so it does not need its own template wrapper. `localeSource` itself is never raw JS; it is a template like any other step input (see above).

## Static Validation (`ap_validate_flow`)

- `$t` added to the root allow-list in `extractReferencedStepNames` alongside `connections`/`variables`. Defensive rather than live today: the existing `\{\{(\w+)` extraction can never actually capture a `$`-prefixed root (`\w` excludes `$`), so no current input reaches this branch — it guards against that regex being loosened later without anyone re-deriving why `$t` must stay excluded.
- Categories: `translation_key` (error — a referenced key does not exist in the project's translations, or the `$t[...]` reference itself is malformed), `translation_default_locale` (error — the key exists but has no value for the project's own canonicalized `defaultLocale`, which is exactly the chain a run with no explicit/inherited locale falls back to), `translation_locale` (warning — missing a *non*-default locale that some other key in the project has, or a `localeSource` that itself references a `$t[...]`; message states the dynamic-locale case is not statically checked). Only `translation_locale` is a warning — everything else blocks `structuredContent.valid` and is reported separately from `structuredContent.warnings`.
- `GET /v1/translations/:id/usages` (see Endpoints above) covers the "is this key still referenced before I delete it" case instead — not flagged proactively inside `ap_validate_flow` itself.

## Caps
`TRANSLATION_KEY_MAX_LENGTH = 255`, `TRANSLATION_VALUE_MAX_LENGTH = 10_000`, `MAX_TRANSLATION_KEYS_PER_PROJECT = 5_000`, `MAX_TRANSLATION_KEYS_PER_UPSERT = 500` (one batch-upsert request), `MAX_TRANSLATION_IMPORT_BYTES = 1_000_000` (one import request body's re-serialized `data` field, not the raw HTTP body), `MAX_LOCALE_TAG_LENGTH = 35`, `MAX_TRANSLATION_LOCALES_PER_KEY = 50`, `TRANSLATION_DESCRIPTION_MAX_LENGTH = 500`, `MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT = 20_000_000` (whole project, checked on every write behind a `pg_advisory_xact_lock` on the project id), `MAX_TRANSLATION_USAGE_FLOWS_SCANNED = 500` (per scan, `/usages` only).

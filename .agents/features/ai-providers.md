# AI Providers

## Summary
The AI Providers module lets platform admins configure one or more LLM backends (OpenAI, Anthropic, Google, Azure, OpenRouter, Cloudflare Gateway, Bedrock, Mistral, or a custom OpenAI-compatible endpoint) for use by AI qadams inside flows. Credentials are encrypted at rest and handed to the engine on demand. There is no credit metering, auto-provisioned managed provider, or billing integration in this repo — operators bring their own provider keys.

## Key Files
- `packages/server/api/src/app/ai/` — backend module (controller, service, entity)
- `packages/shared/src/lib/management/ai-providers/index.ts` — all shared Zod schemas, enums, and request/response types
- `packages/web/src/features/platform-admin/api/ai-provider-api.ts` — frontend API client
- `packages/web/src/features/platform-admin/hooks/ai-provider-hooks.ts` — TanStack Query hooks
- `packages/web/src/app/routes/platform/setup/ai/index.tsx` — platform admin AI setup page
- `packages/web/src/app/routes/platform/setup/ai/universal-pieces/ai-provider-card.tsx` — per-provider card component
- `packages/web/src/app/routes/platform/setup/ai/universal-pieces/upsert-provider-dialog.tsx` — create/edit provider dialog
- `packages/web/src/app/routes/platform/setup/ai/universal-pieces/upsert-provider-config-form.tsx` — provider config form
- `packages/web/src/app/routes/platform/setup/ai/universal-pieces/model-form-popover.tsx` — model selection popover
- `packages/web/src/features/agents/ai-model/index.tsx` — AI model selector used in agent step settings
- `packages/web/src/features/agents/ai-model/hooks.ts` — hooks for listing available models per provider

## Domain Terms
- **AIProvider**: A platform-scoped entity linking an LLM vendor's credentials to the platform.
- **AIProviderName**: Enum of supported vendors (`openai`, `openrouter`, `anthropic`, `azure`, `google`, `cloudflare-gateway`, `custom`, `bedrock`, `mistral`).
- **EncryptedObject**: The `auth` field is AES-256-encrypted at rest; decrypted only for engine access.
- **Model cache**: In-memory cache of models per provider *row*, cleared daily at midnight via cron.
- **Provider ref**: How a provider is addressed — its row id, or an `AIProviderName`. The name form resolves to the platform's **oldest** row of that type and exists permanently, because published qadam versions are pinned and build their URLs from the enum.

## Entity

**AIProvider**: id, displayName, platformId, provider (AIProviderName enum), auth (EncryptedObject), config (JSON), enabledForChat (boolean, default false). Relation: platform (CASCADE).

Unique on `(platformId, provider)` **only where `provider <> 'custom'`** — a platform may hold many custom (OpenAI-compatible) providers and exactly one of each other type. The index is partial, so `ON CONFLICT ('platformId','provider')` no longer has a matching arbiter (`42P10`); conflict on `id` instead.

Custom rows are not unbounded: `create()` caps them at `AP_MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM` (default 20) inside its own transaction, behind a `pg_advisory_xact_lock`. That cap is the only ceiling on custom rows now that the unique index no longer covers them.

## Supported Providers (9)

Registered in `packages/server/api/src/app/ai/providers/index.ts`; auth/config shapes in `packages/shared/src/lib/management/ai-providers/index.ts`.

| Provider | Auth Fields | Config Fields | Notes |
|----------|------------|---------------|-------|
| OPENAI | apiKey | — | GPT models |
| ANTHROPIC | apiKey | — | Claude models |
| GOOGLE | apiKey | — | Gemini models |
| AZURE | apiKey | resourceName, apiVersion | Azure OpenAI |
| OPENROUTER | apiKey | — | Model list fetched live from `https://openrouter.ai/api/v1/models` |
| CLOUDFLARE_GATEWAY | apiKey | accountId, gatewayId, models, vertexProject, vertexRegion | Proxied via Cloudflare AI Gateway |
| CUSTOM | apiKey | apiKeyHeader, baseUrl, models, defaultHeaders | OpenAI-compatible (LM Studio, Ollama) |
| BEDROCK | accessKeyId, secretAccessKey | region | AWS Bedrock |
| MISTRAL | apiKey | — | Mistral models |

## Model Caching

Models listed per provider are cached in an in-process LRU bounded at 200 entries (`packages/server/api/src/app/ai/models-cache.ts`), keyed by the provider row's `id` and its `updated` timestamp — so editing credentials or config invalidates the entry, and two rows never share one. Providers whose config carries an explicit `models` list bypass the cache. `aiProviderService.setup()` registers a `0 0 * * *` node-cron job that clears the whole cache daily at midnight.

## Endpoints

- `GET /` — list providers
- `GET /:providerRef/config` — get provider config + decrypted auth (engine-only access). `providerRef` is a row id or a provider name
- `GET /:providerRef/models` — list available models (cached)
- `POST /` — create provider (validates credentials first)
- `POST /:id` — update provider (re-validates if auth changed)
- `DELETE /:id` — delete provider

## Engine Integration

During flow execution, AI pieces call `GET /v1/ai-providers/{providerRef}/config` to get credentials. Versions pinned before id-addressing send the provider name and get the oldest matching row. The engine token provides authorization.

From `@aiqadam/qadam-ai` 0.4.4, the Run Agent step sends the row id when its `aiProviderModel` carries a `providerId`, through both `createAIModel` and `createEmbeddingModel`; the SDK client is then built from the answering row's `provider` rather than from the name stored in the step. The other five AI actions still send the name only.

The qadam derives that ref in one place (`resolveProviderRef` in `ai-sdk.ts`). An empty `providerId` is read as absent and falls back to the name, and anything else must match the same shape the controller enforces on `:providerRef` (`ProviderRefSchema` — an `AIProviderName` value or a 21-character `ApId`) or the call fails before a URL is built; `encodeURIComponent` does not neutralise a bare `..`. When the answering row's type differs from the name the step stored, the qadam logs a warning: only the model client follows the row, while web search, the OpenAI responses API and every other name-keyed capability still follow the stored name.

## Frontend

The platform admin AI setup page lives at `/platform/setup/ai`. It renders an `ai-provider-card` per provider row (`ai-provider-rows.ts` — one card per singleton provider type, one per custom row) plus one "Add Provider" slot that opens `upsert-provider-dialog` to create another custom row. The `upsert-provider-config-form` adapts its fields to the selected `AIProviderName`. The `model-form-popover` lets admins configure which models are exposed per provider.

Inside the builder, the agent step settings use `features/agents/ai-model/index.tsx` (with `hooks.ts` and `provider-options.ts`) to render a model selector. It offers one entry per provider **row**, not per provider type, so a platform's several custom rows are separately selectable; entries are keyed and emitted by row id, and a row carrying a base url shows it under its display name because two rows may share a display name. Selecting one emits `{ providerId, provider, model }` into the step's `aiProviderModel`. The model list is fetched with `aiProviderApi.listModelsForProvider(providerId)` — `GET /v1/ai-providers/:providerRef/models` — and cached under that id, while `ALLOWED_CHAT_MODELS_BY_PROVIDER` is still applied by provider *name*. Which entry a stored step points at is resolved the same way the server resolves a ref: row id first, then provider name; a ref that resolves to nothing leaves the picker empty rather than silently re-pointing the step at another row.

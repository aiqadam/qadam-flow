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
- **Model cache**: In-memory cache of models per provider, cleared daily at midnight via cron.

## Entity

**AIProvider**: id, displayName, platformId (UNIQUE with provider), provider (AIProviderName enum), auth (EncryptedObject), config (JSON), enabledForChat (boolean, default false). Relation: platform (CASCADE).

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

Models listed per provider are cached in an in-process `Map`, keyed by provider plus a fingerprint of its auth/config. Providers whose config carries an explicit `models` list bypass the cache. `aiProviderService.setup()` registers a `0 0 * * *` node-cron job that clears the whole cache daily at midnight.

## Endpoints

- `GET /` — list providers
- `GET /:provider/config` — get provider config + decrypted auth (engine-only access)
- `GET /:provider/models` — list available models (cached)
- `POST /` — create provider (validates credentials first)
- `POST /:id` — update provider (re-validates if auth changed)
- `DELETE /:id` — delete provider

## Engine Integration

During flow execution, AI pieces call `GET /v1/ai-providers/{provider}/config` to get credentials. The engine token provides authorization.

## Frontend

The platform admin AI setup page lives at `/platform/setup/ai`. It renders an `ai-provider-card` for each configured provider and an "Add Provider" button that opens `upsert-provider-dialog`. The `upsert-provider-config-form` adapts its fields to the selected `AIProviderName`. The `model-form-popover` lets admins configure which models are exposed per provider.

Inside the builder, the agent step settings use `features/agents/ai-model/index.tsx` (with `hooks.ts`) to render a model selector that queries `GET /v1/ai-providers/:provider/models` via `aiProviderApi.listModelsForProvider()`.

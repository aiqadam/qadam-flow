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
| CUSTOM | apiKey | apiKeyHeader, baseUrl, models, defaultHeaders, extraBody | OpenAI-compatible (LM Studio, Ollama, vLLM) |
| BEDROCK | accessKeyId, secretAccessKey | region | AWS Bedrock |
| MISTRAL | apiKey | — | Mistral models |

## Chat reasoning (#566)

An optional `reasoning: { enabled, budgetTokens }` (`ChatReasoningConfig`) on the config of an ANTHROPIC, BEDROCK, OPENROUTER or GOOGLE row (`CHAT_REASONING_PROVIDERS`). When it is on and the row is the chat provider, the chat asks the model to reason; `chat.md` has what each provider is sent. On Anthropic and Bedrock that depends on the model: Claude 3.7 through 4.5 use the budget, Claude 4.6 and later think adaptively, and Claude before 3.7 is sent nothing; on Bedrock, models other than Claude are sent nothing either. Absent or `enabled: false` means the chat's requests are unchanged.

- **Stored in the `config` JSON column.** No migration. The budget is kept when the switch goes off, so turning it back on restores the admin's value. A budget the schema would refuse (cleared, or out of range) is reset to `DEFAULT_CHAT_REASONING_BUDGET_TOKENS` instead, because the budget input and its message are hidden with the switch off and the save would otherwise fail with nothing on screen.
- **Budget bounds.** 1,024 (Anthropic's floor) to 24,000, whole tokens, with the `reasoningBudgetTokensOutOfRange` message. The ceiling keeps budget plus reply below the smallest output limit a budget meets: Claude Opus 4 and 4.1 at 32,000, where Bedrock sends the budget plus 4,096.
- **Refused elsewhere.** OPENAI and MISTRAL configs reject the key (`reasoningNotSupportedByProvider`); AZURE, CUSTOM and CLOUDFLARE_GATEWAY strip it. The rejection is load-bearing: `UpdateAIProviderRequest.config` is the untagged union, and without it an out-of-range budget fell through to the empty OpenAI member, parsed to `{}` and wiped the row's setting with a 200.
- **Not a secret.** It is not redacted from non-admin list responses, like the rest of a non-CUSTOM config.
- **Chat only.** Flow steps and the AI qadams never read it. The web form shows the switch and the budget for the four providers only (`ChatReasoningFields` in `upsert-provider-config-form.tsx`).

## CUSTOM `extraBody`

An optional JSON object merged into every chat-completions body the row sends, through the AI SDK's `transformRequestBody` (`mergeOpenAICompatibleExtraBody` in shared). It is how an operator sets server-side template or sampling parameters the SDK has no option for — the motivating case is Qwen on vLLM, where `{ "chat_template_kwargs": { "enable_thinking": false } }` turns thinking off. Two rows pointing at the same endpoint with different `extraBody` give two selectable modes (e.g. non-thinking and `reasoning_effort: "low"`).

- Applied in both model builders: the qadam's `createAIModel` (`ai-sdk.ts`) and the server chat's `chatAiUtils.createChatModel`. The qadam's model object is also what the engine uses for per-tool property extraction (`engine/src/lib/tools/index.ts`), so a Run Agent step's hidden calls get the same parameters as its visible ones.
- Keys the SDK owns (`OPENAI_COMPATIBLE_RESERVED_BODY_KEYS`: `model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `response_format`) are rejected by the schema and dropped again at merge time, since the qadam reads `config` back as an unchecked cast.
- Capped at 8192 serialized characters (`JSON.stringify(...).length`, not bytes). Chat models only: CUSTOM image models ignore it. Redacted from non-admin list responses like `defaultHeaders`, because gateways that authenticate in the body put their token there.

## Model context window

`AIProviderModel.contextWindowTokens` is the model's context window in tokens. It is optional, because most providers do not say. The chat reads it to decide when to compact a long conversation (#567).

- **Where it comes from:**
  - **Model lists that report it:** OpenRouter `context_length` (nullable), Google `inputTokenLimit` and Mistral `max_context_length`.
  - **The operator:** the optional `contextWindowTokens` on a CUSTOM or Cloudflare Gateway catalogue entry (`ProviderModelConfig`), set in the model popover.
  - **Nothing else:** OpenAI, Anthropic, Azure and Bedrock do not report it through the endpoints we call, and there is no per-model editor for them.
- **Reaching the chat:** `aiProviderService.listModels` rebuilds each model from a fixed set of fields before caching it, and `contextWindowTokens` has to be one of them. `test/unit/app/chat/chat-model-context-window.test.ts` covers the whole path, from a stubbed HTTP model list through the real service and cache to `chatModel.resolve`.
- **Validation:** a reported value goes through `parseModelContextWindowTokens`, the same `ModelContextWindowTokens` bounds (1,024 to 10,000,000, integer) the operator is held to. Anything else reads as "not reported".
- **When unknown:** readers assume `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS`, which is 128k. It is not smaller because the chat's own system prompt and tool schemas are about 23k tokens before the first message. The model list in the provider form states the assumption on every text model without a size.

## Model capabilities (#848)

`AIProviderModel.capabilities` (`AIProviderModelCapabilities`) describes a model by what it can do — `inputModalities`, `outputModalities`, `chat`, `tools` — instead of the single `image` | `text` type. It replaced the hardcoded chat allow-list (`ALLOWED_CHAT_MODELS_BY_PROVIDER`), which went stale as providers retired and added models: Google retired `gemini-2.5-flash` for new keys and pointed at `gemini-3.8-flash`, which the list did not carry, so the picker dropped the only model that worked.

- **Filled from the provider's own catalogue** where it reports one: Google `supportedGenerationMethods` (`generateContent` = chat, `predict`/`image` = image output), OpenRouter `architecture.input_modalities` / `output_modalities` and `supported_parameters` (`tools`), Mistral `capabilities` (`completion_chat`, `function_calling`, `vision`), Bedrock `inputModalities` / `outputModalities` / `responseStreamingSupported`.
- **Inferred only for OpenAI**, whose `/v1/models` reports an id and nothing else: image ids (`dall-e*`, `gpt-image*`) output an image, a small set of stable non-chat families (embeddings, speech, moderation, legacy completions) are excluded, and everything else is a chat model — so a model OpenAI adds tomorrow is offered the day it appears. Azure deployments assume a chat model; Anthropic's catalogue is chat models only. CUSTOM and Cloudflare Gateway derive capabilities from the operator's `modelType` (`capabilitiesFromModelType`).
- **`type` stays on the wire, derived** from the capabilities by `deriveAIProviderModelType` (IMAGE when an output modality is `image`, else TEXT). Pinned `@aiqadam/qadam-ai` versions still filter the catalogue on it, so it cannot be removed without breaking every already-published qadam; new readers use `capabilities`. `@aiqadam/qadam-ai` filters its text/image model dropdowns on capabilities.
- **Consumers filter on a capability.** The chat and the agent-step picker take `capabilities.chat`; `chatModel.resolve` validates a pinned model against the same flag and picks the zero-config default with `pickDefaultChatModel` (the function the web picker also uses, so the shown default is the one the chat runs); `ap_list_ai_models` lists chat models; the image action takes `outputModalities.includes('image')`. A multimodal model that both chats and draws is offered to both, which the old single type could not express.
- **Default model.** `pickDefaultChatModel` demotes preview builds so a stable model wins and otherwise keeps the provider's own order; an admin-set default per provider row is deliberately out of scope (see #848).

## CUSTOM `streamUsage`

When this optional boolean is absent or true, chat asks the server for token counts (`includeUsage` → `stream_options.include_usage`). The chat's context fill reads those counts (see `chat.md`).

- **Why the opt-out exists:** `stream_options` is a reserved key, so `extraBody` cannot remove it, and a server that rejects unknown body fields would otherwise fail every chat turn.
- **Scope:** chat only. The qadam's own `createAIModel` does not read it.

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

From `@aiqadam/qadam-ai` 0.4.4, the Run Agent step sends the row id when its `aiProviderModel` carries a `providerId`, through both `createAIModel` and `createEmbeddingModel`; the SDK client is then built from the answering row's `provider` rather than from the name stored in the step.

From 0.4.5 the other five actions (`ask-ai`, `classify-text`, `generate-image`, `extract-structured-data`, `summarize-text`) do the same, through an **optional** `providerId` prop that `aiProps` returns alongside `provider`. Optional is load-bearing: `flow-version-validator-util` parses a stored step's input against a schema built from the action's props, so a required prop would turn every step saved before 0.4.5 invalid. Absent means the provider name is sent and the oldest row of that type answers — identical to pre-0.4.5 behaviour.

`aiProps().provider` still emits the provider **name** and now offers one entry per provider *type* rather than one per row, labelled with the first row of that type in server order — which is the row a bare name reaches. Before that, two custom rows produced two options carrying the same value: `searchable-select` keys options by index so both were clickable, resolves the trigger label by value equality so the second rendered as the first, and the server answered with the oldest row. `aiProps().providerId` is where a row is chosen; it lists the rows of the selected type, valued by row id and disambiguated by base url when two share a display name. `aiProps().model` refreshes on both and builds its URL through `resolveProviderRef`, so the catalogue comes from the row the step will run against.

The qadam derives that ref in one place (`resolveProviderRef` in `ai-sdk.ts`, exported so `props.ts` uses the same one). An empty `providerId` is read as absent and falls back to the name, and anything else must match the same shape the controller enforces on `:providerRef` (`ProviderRefSchema` — an `AIProviderName` value or a 21-character `ApId`) or the call fails before a URL is built; `encodeURIComponent` does not neutralise a bare `..`. When the answering row's type differs from the name the step stored, the qadam logs a warning by default: only the model client follows the row, while web search, the OpenAI responses API and every other name-keyed capability still follow the stored name. `run_agent` and `ask-ai` — the two actions that can attach a provider-specific web-search `ToolSet` built from the stored name — pass `createAIModel({ requireProviderMatch: true })` whenever web search is enabled, so a mismatch throws a named error before that tool set ever reaches the SDK, instead of failing downstream with a message that names nothing.

## Frontend

The platform admin AI setup page lives at `/platform/setup/ai`. It renders an `ai-provider-card` per provider row (`ai-provider-rows.ts` — one card per singleton provider type, one per custom row) plus one "Add Provider" slot that opens `upsert-provider-dialog` to create another custom row. The `upsert-provider-config-form` adapts its fields to the selected `AIProviderName`. The `model-form-popover` lets admins configure which models are exposed per provider.

Inside the builder, the agent step settings use `features/agents/ai-model/index.tsx` (with `hooks.ts` and `provider-options.ts`) to render a model selector. It offers one entry per provider **row**, not per provider type, so a platform's several custom rows are separately selectable; entries are keyed and emitted by row id, and a row carrying a base url shows it under its display name because two rows may share a display name. Selecting one emits `{ providerId, provider, model }` into the step's `aiProviderModel`. The model list is fetched with `aiProviderApi.listModelsForProvider(providerId)` — `GET /v1/ai-providers/:providerRef/models` — and cached under that id. The picker offers the models the provider reports as chat-capable (`capabilities.chat`), not a hardcoded allow-list, so a model the provider adds or retires is offered or hidden the day the provider reports it (#848). Which entry a stored step points at is resolved the same way the server resolves a ref: row id first, then provider name; a ref that resolves to nothing leaves the picker empty rather than silently re-pointing the step at another row.

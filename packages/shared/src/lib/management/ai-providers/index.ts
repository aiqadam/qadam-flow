import { z } from 'zod'
import { BaseModelSchema } from '../../core/common/base-model'
import { tryCatchSync } from '../../core/common/try-catch'
import { omit, spreadIfDefined } from '../../core/common/utils/object-utils'
import { formErrors } from '../../form-errors'

export enum AIProviderName {
    OPENAI = 'openai',
    OPENROUTER = 'openrouter',
    ANTHROPIC = 'anthropic',
    AZURE = 'azure',
    GOOGLE = 'google',
    CLOUDFLARE_GATEWAY = 'cloudflare-gateway',
    CUSTOM = 'custom',
    BEDROCK = 'bedrock',
    MISTRAL = 'mistral',
}


export enum AIProviderModelType {
    IMAGE = 'image',
    TEXT = 'text',
}

export const BaseAIProviderAuthConfig = z.object({
    apiKey: z.string(),
})
export type BaseAIProviderAuthConfig = z.infer<typeof BaseAIProviderAuthConfig>

export const AnthropicProviderAuthConfig = BaseAIProviderAuthConfig
export type AnthropicProviderAuthConfig = z.infer<typeof AnthropicProviderAuthConfig>

export const OpenAICompatibleProviderAuthConfig = BaseAIProviderAuthConfig
export type OpenAICompatibleProviderAuthConfig = z.infer<typeof OpenAICompatibleProviderAuthConfig>

export const CloudflareGatewayProviderAuthConfig = BaseAIProviderAuthConfig
export type CloudflareGatewayProviderAuthConfig = z.infer<typeof CloudflareGatewayProviderAuthConfig>

export const AzureProviderAuthConfig = BaseAIProviderAuthConfig
export type AzureProviderAuthConfig = z.infer<typeof AzureProviderAuthConfig>

export const GoogleProviderAuthConfig = BaseAIProviderAuthConfig
export type GoogleProviderAuthConfig = z.infer<typeof GoogleProviderAuthConfig>

export const OpenAIProviderAuthConfig = BaseAIProviderAuthConfig
export type OpenAIProviderAuthConfig = z.infer<typeof OpenAIProviderAuthConfig>

export const OpenRouterProviderAuthConfig = BaseAIProviderAuthConfig
export type OpenRouterProviderAuthConfig = z.infer<typeof OpenRouterProviderAuthConfig>

export const BedrockProviderAuthConfig = z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
})
export type BedrockProviderAuthConfig = z.infer<typeof BedrockProviderAuthConfig>

export const MistralProviderAuthConfig = BaseAIProviderAuthConfig
export type MistralProviderAuthConfig = z.infer<typeof MistralProviderAuthConfig>

// The providers whose chat can be asked to reason (#566). OpenAI and Azure are not among them: chat
// reaches them through Chat Completions, which returns no reasoning text, and moving them to the
// Responses API would change the wire for every row. CUSTOM and Cloudflare Gateway already carry
// `extraBody`, which is how an OpenAI-compatible server is told to think.
export const CHAT_REASONING_PROVIDERS: readonly AIProviderName[] = [
    AIProviderName.ANTHROPIC,
    AIProviderName.BEDROCK,
    AIProviderName.OPENROUTER,
    AIProviderName.GOOGLE,
]

// 1,024 is Anthropic's own floor for `budget_tokens`. The ceiling is set by the smallest output
// limit a budget can meet, because a budget must stay below `max_tokens` and chat sets no
// `maxOutputTokens`: `@ai-sdk/anthropic` then sends the model's own maximum and clamps budget plus
// that to it, which on Claude Opus 4 and 4.1 is 32,000; `@ai-sdk/amazon-bedrock` sends the budget
// plus 4,096, which must fit the same 32,000. 24,000 leaves at least 3,904 tokens for the reply on
// both, and more than 8,000 on direct Anthropic.
export const MIN_CHAT_REASONING_BUDGET_TOKENS = 1_024
export const MAX_CHAT_REASONING_BUDGET_TOKENS = 24_000
export const DEFAULT_CHAT_REASONING_BUDGET_TOKENS = 8_000

export const ChatReasoningBudgetTokens = z.int(formErrors.reasoningBudgetTokensOutOfRange)
    .min(MIN_CHAT_REASONING_BUDGET_TOKENS, formErrors.reasoningBudgetTokensOutOfRange)
    .max(MAX_CHAT_REASONING_BUDGET_TOKENS, formErrors.reasoningBudgetTokensOutOfRange)

// Whether the chat asks this row's models to reason, and how much they may spend on it. Off unless
// an admin turns it on, because it costs tokens and time on every turn. Chat only: flow steps and
// the AI qadams never read it, and neither does the chat's own compaction summariser.
export const ChatReasoningConfig = z.object({
    enabled: z.boolean(),
    budgetTokens: ChatReasoningBudgetTokens,
})
export type ChatReasoningConfig = z.infer<typeof ChatReasoningConfig>

// `AIProviderConfig` is an untagged union whose tail is empty objects, and an empty object strips
// what it does not know. Without this, an update carrying an out-of-range budget fails every member
// that knows `reasoning`, then parses to `{}` against the OpenAI member — and the row's setting is
// silently wiped by a request that should have been refused.
const NoChatReasoning = {
    reasoning: z.undefined({ error: formErrors.reasoningNotSupportedByProvider }).optional(),
}

export const AnthropicProviderConfig = z.object({
    reasoning: ChatReasoningConfig.optional(),
})
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfig>

// A provider's model catalogue is operator-supplied and stored verbatim on the row, served back
// from `GET /` and held in the in-process model cache. Nothing downstream bounds it, and the
// server's body limit is 25 MB, so without these two caps one request decides how much memory a
// row costs forever. The numbers are far above any real catalogue — the longest ids in use are
// Cloudflare Gateway's `google-vertex-ai/<publisher>/<model>` form at well under 100 characters,
// and the picker these lists feed is curated by hand.
const MAX_MODEL_IDENTIFIER_LENGTH = 200
const MAX_MODELS_PER_PROVIDER = 200

// What the chat assumes when neither the provider's model list nor the operator says how large a
// model's context window is. Not smaller: the chat's own system prompt and tool schemas are about
// 23k tokens before the first message, so a 32k assumption would leave an empty conversation
// already due for compaction. Every current cloud chat model offers at least this much, so for them
// an unknown size can only make the chat compact earlier than it had to, never overflow.
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 128_000
export const MIN_MODEL_CONTEXT_WINDOW_TOKENS = 1_024
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 10_000_000

export const ModelContextWindowTokens = z.int(formErrors.contextWindowTokensOutOfRange)
    .min(MIN_MODEL_CONTEXT_WINDOW_TOKENS, formErrors.contextWindowTokensOutOfRange)
    .max(MAX_MODEL_CONTEXT_WINDOW_TOKENS, formErrors.contextWindowTokensOutOfRange)

// A provider's model list is third-party data, so a size it reports is kept only when it is one
// the operator could have typed in themselves; anything else reads as "not reported".
export function parseModelContextWindowTokens(value: unknown): number | undefined {
    const parsed = ModelContextWindowTokens.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

export const ProviderModelConfig = z.object({
    modelId: z.string().max(MAX_MODEL_IDENTIFIER_LENGTH, formErrors.modelIdentifierTooLong),
    modelName: z.string().max(MAX_MODEL_IDENTIFIER_LENGTH, formErrors.modelIdentifierTooLong),
    modelType: z.nativeEnum(AIProviderModelType),
    contextWindowTokens: ModelContextWindowTokens.optional(),
})
export type ProviderModelConfig = z.infer<typeof ProviderModelConfig>

// Keys the AI SDK itself writes into a chat-completions body. Letting operator config replace them
// would silently re-point the model, drop the conversation or the tools, or break stream parsing,
// so `extraBody` may add parameters (`chat_template_kwargs`, `top_k`, `reasoning_effort`, ...) but
// never own one of these.
export const OPENAI_COMPATIBLE_RESERVED_BODY_KEYS: readonly string[] = [
    'model',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'stream_options',
    'response_format',
]

// Merged into every chat request the row makes and stored verbatim on the row, so bound it the same
// way the model catalogue above is bounded: 8192 serialized characters, far above any real set of
// sampling / template parameters.
const MAX_EXTRA_BODY_SERIALIZED_LENGTH = 8192

export const OpenAICompatibleExtraBody = z.record(z.string(), z.unknown(), { error: formErrors.extraBodyMustBeObject })
    .refine((body) => Object.keys(body).every((key) => !OPENAI_COMPATIBLE_RESERVED_BODY_KEYS.includes(key)), formErrors.extraBodyReservedKey)
    .refine((body) => JSON.stringify(body).length <= MAX_EXTRA_BODY_SERIALIZED_LENGTH, formErrors.extraBodyTooLarge)

export const OpenAICompatibleProviderConfig = z.object({
    apiKeyHeader: z.string(),
    baseUrl: z.string(),
    models: z.array(ProviderModelConfig).max(MAX_MODELS_PER_PROVIDER, formErrors.tooManyModels),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
    extraBody: OpenAICompatibleExtraBody.optional(),
    // Whether chat asks for token counts (`stream_options.include_usage`). Absent means yes. An
    // opt-out exists because the parameter is one the SDK owns — `extraBody` cannot remove it — and
    // a strict server that rejects unknown body fields would otherwise fail every chat turn.
    streamUsage: z.boolean().optional(),
})
export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderConfig>

/**
 * Adds a CUSTOM row's `extraBody` to an outgoing chat-completions body. Reserved keys are dropped
 * here as well as rejected by the schema, and a non-object value is ignored: both call sites read
 * `config` as an unchecked cast, so this is the last point where a stored row that predates (or
 * bypassed) the refine can still be kept from overwriting `model`, `messages` or `tools`, or from
 * failing every request on the provider.
 */
export function mergeOpenAICompatibleExtraBody({ body, extraBody }: { body: Record<string, unknown>, extraBody: unknown }): Record<string, unknown> {
    if (typeof extraBody !== 'object' || extraBody === null || Array.isArray(extraBody)) {
        return body
    }
    const allowed = Object.fromEntries(Object.entries(extraBody).filter(([key]) => !OPENAI_COMPATIBLE_RESERVED_BODY_KEYS.includes(key)))
    return { ...body, ...allowed }
}


export const CloudflareGatewayProviderConfig = z.object({
    accountId: z.string(),
    gatewayId: z.string(),
    models: z.array(ProviderModelConfig).max(MAX_MODELS_PER_PROVIDER, formErrors.tooManyModels),
    vertexProject: z.string().optional(),
    vertexRegion: z.string().optional(),
})
export type CloudflareGatewayProviderConfig = z.infer<typeof CloudflareGatewayProviderConfig>

export const DEFAULT_AZURE_API_VERSION = '2024-10-21'

// `resourceName` is the leftmost label of `<resourceName>.openai.azure.com`, so an unconstrained
// string is a host injection rather than a typo risk: `attacker.example.com/` resolves the request
// to `https://attacker.example.com/.openai.azure.com/...`, with the `api-key` header attached
// (#276). Azure itself only ever issues names of letters, digits and hyphens, 2–64 characters, so
// nothing legitimate is excluded — and every character that could re-point the host (`/`, `.`,
// `:`, `@`, whitespace, `\`, `?`, `#`) is.
const AZURE_RESOURCE_NAME_PATTERN = /^[a-zA-Z0-9-]{2,64}$/

export function isValidAzureResourceName(resourceName: unknown): resourceName is string {
    return typeof resourceName === 'string' && AZURE_RESOURCE_NAME_PATTERN.test(resourceName)
}

// Thrown at the two sinks that build the Azure host from a stored row (`azure-provider.listModels`
// and `chatAiUtils.createChatModel`), which read `config` straight from the database and never
// re-parse it — so the schema alone does not cover a row written before the constraint existed.
// Reached only by an operator, so it says what to do rather than only what is wrong. It travels as
// a `QadamFlowError` `params.message`, which is what `apiErrorUtils.extractServerMessage` renders;
// it is present verbatim in packages/web/public/locales/en/translation.json, same as
// `CUSTOM_PROVIDER_LIMIT_MESSAGE`, so the dialog's `i18n.exists` check finds the translated form.
export const INVALID_AZURE_RESOURCE_NAME_MESSAGE = 'The stored Azure resource name is not valid. Re-save this provider with a resource name of 2-64 letters, digits and hyphens.'

// Same reasoning as the Azure message above, for the Bedrock `region` sink.
export const INVALID_AWS_REGION_MESSAGE = 'The stored AWS region is not valid. Re-save this provider with a region such as us-east-1.'

export const AzureProviderConfig = z.object({
    resourceName: z.string().regex(AZURE_RESOURCE_NAME_PATTERN, formErrors.invalidAzureResourceName),
    apiVersion: z.preprocess(
        (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
        z.string().optional(),
    ),
})
export type AzureProviderConfig = z.infer<typeof AzureProviderConfig>

export const GoogleProviderConfig = z.object({
    reasoning: ChatReasoningConfig.optional(),
})
export type GoogleProviderConfig = z.infer<typeof GoogleProviderConfig>

export const OpenAIProviderConfig = z.object(NoChatReasoning)
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfig>

export const OpenRouterProviderConfig = z.object({
    reasoning: ChatReasoningConfig.optional(),
})
export type OpenRouterProviderConfig = z.infer<typeof OpenRouterProviderConfig>

// The same defect as `resourceName`, verified against the installed SDK rather than inferred:
// `@aws-sdk/client-bedrock`'s endpoint resolver builds `https://bedrock.{region}.amazonaws.com`
// with no validation, so a region of `evil.com/` resolves to host `bedrock.evil.com` and
// `x@evil.com` to `evil.com.amazonaws.com`. What leaks there is a SigV4 `Authorization` header —
// the access key id and a signature — rather than a raw key, so it is a smaller loss than #276's
// `api-key`, but it is the identical shape and is closed the identical way. Every AWS region id
// is lowercase letters, digits and hyphens.
const AWS_REGION_PATTERN = /^[a-z0-9-]{1,64}$/

export function isValidAwsRegion(region: unknown): region is string {
    return typeof region === 'string' && AWS_REGION_PATTERN.test(region)
}

export const BedrockProviderConfig = z.object({
    region: z.string().regex(AWS_REGION_PATTERN, formErrors.invalidAwsRegion),
    reasoning: ChatReasoningConfig.optional(),
})
export type BedrockProviderConfig = z.infer<typeof BedrockProviderConfig>

export const MistralProviderConfig = z.object(NoChatReasoning)
export type MistralProviderConfig = z.infer<typeof MistralProviderConfig>

export const AIProviderAuthConfig = z.union([
    AnthropicProviderAuthConfig,
    AzureProviderAuthConfig,
    GoogleProviderAuthConfig,
    OpenAIProviderAuthConfig,
    OpenRouterProviderAuthConfig,
    CloudflareGatewayProviderAuthConfig,
    OpenAICompatibleProviderAuthConfig,
    BedrockProviderAuthConfig,
    MistralProviderAuthConfig,
])
export type AIProviderAuthConfig = z.infer<typeof AIProviderAuthConfig>
// Order matters, put schemas with required fields first, empty ones last. This is to avoid empty objects matching any object.
export const AIProviderConfig = z.union([
    OpenAICompatibleProviderConfig,
    CloudflareGatewayProviderConfig,
    AzureProviderConfig,
    BedrockProviderConfig,
    AnthropicProviderConfig,
    GoogleProviderConfig,
    OpenAIProviderConfig,
    OpenRouterProviderConfig,
    MistralProviderConfig,
])
export type AIProviderConfig = z.infer<typeof AIProviderConfig>

const ProviderConfigUnion = z.discriminatedUnion('provider', [
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.OPENAI),
        config: OpenAIProviderConfig,
        auth: OpenAIProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.OPENROUTER),
        config: OpenRouterProviderConfig,
        auth: OpenRouterProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.ANTHROPIC),
        config: AnthropicProviderConfig,
        auth: AnthropicProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.AZURE),
        config: AzureProviderConfig,
        auth: AzureProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.GOOGLE),
        config: GoogleProviderConfig,
        auth: GoogleProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.CLOUDFLARE_GATEWAY),
        config: CloudflareGatewayProviderConfig,
        auth: CloudflareGatewayProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.CUSTOM),
        config: OpenAICompatibleProviderConfig,
        auth: OpenAICompatibleProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.BEDROCK),
        config: BedrockProviderConfig,
        auth: BedrockProviderAuthConfig,
    }),
    z.object({
        displayName: z.string().min(1),
        provider: z.literal(AIProviderName.MISTRAL),
        config: MistralProviderConfig,
        auth: MistralProviderAuthConfig,
    }),
])

const providerConfigSchemas = {
    [AIProviderName.OPENAI]: OpenAIProviderConfig,
    [AIProviderName.OPENROUTER]: OpenRouterProviderConfig,
    [AIProviderName.ANTHROPIC]: AnthropicProviderConfig,
    [AIProviderName.AZURE]: AzureProviderConfig,
    [AIProviderName.GOOGLE]: GoogleProviderConfig,
    [AIProviderName.CLOUDFLARE_GATEWAY]: CloudflareGatewayProviderConfig,
    [AIProviderName.CUSTOM]: OpenAICompatibleProviderConfig,
    [AIProviderName.BEDROCK]: BedrockProviderConfig,
    [AIProviderName.MISTRAL]: MistralProviderConfig,
}

/**
 * Parses a config against the schema of one specific provider, returning null when it does not fit.
 *
 * `AIProviderConfig` is a plain union ending in several `z.object({})` members, so an incomplete
 * config for a provider that has required fields does not fail — it falls through to an empty
 * member and parses to `{}`, silently discarding every field. Anything holding a config together
 * with the provider it belongs to must use this instead of the union.
 */
export function parseProviderConfig({ provider, config }: { provider: AIProviderName, config: unknown }): AIProviderConfig | null {
    const parsed = providerConfigSchemas[provider].safeParse(config)
    return parsed.success ? parsed.data : null
}

// `baseUrl` on a CUSTOM row is an unconstrained `z.string()` (#276/#297's own text: an operator
// can put userinfo `https://user:token@host` or a query-string `?api_key=...` in it, and either
// leaks to a low-privileged reader the same way `defaultHeaders` does), so a redacted row keeps
// only the origin — enough for the model picker's disambiguation, nothing past the host.
// `apiKeyHeader` and `models` are unaffected: a header *name* is not a credential value, and
// `parseProviderConfig`/every other reader of a stored config still gets a real `AIProviderConfig`
// for the two fields that could not have carried a secret in the first place.
export const PublicOpenAICompatibleProviderConfig = OpenAICompatibleProviderConfig.omit({ defaultHeaders: true, extraBody: true }).extend({
    baseUrl: z.string().optional(),
})
export type PublicOpenAICompatibleProviderConfig = z.infer<typeof PublicOpenAICompatibleProviderConfig>

/**
 * Strips or masks the fields of a stored CUSTOM config that can themselves carry a credential:
 * `defaultHeaders` is an operator-defined record, and the second-header pattern (a signing header
 * alongside the primary `apiKeyHeader`) puts a live secret there; `extraBody` is the same kind of
 * operator-defined record merged into the request body, where gateways that authenticate in the
 * body (a `user` token, a tenant key) put theirs; `baseUrl` is a free-form string
 * that can carry the same secret in its userinfo or query string, and can disclose an internal
 * hostname besides. `baseUrl` and `defaultHeaders` are the exact fields issue #297 (echoing #277)
 * names as leaking "the same class of operator credentials". `apiKeyHeader` and `models` are not secret-shaped and stay as-is
 * — they are read directly off a redacted list response by the builder's model picker
 * (`provider-options.ts`'s `readBaseUrl`) and by the qadam's own picker (`props.ts`'s
 * `shareableLabels`) to disambiguate two rows of the same provider type, which is why `baseUrl` is
 * masked to its origin rather than dropped outright.
 *
 * Every provider other than CUSTOM has no field shaped like a credential in its `config` at all
 * (`resourceName`, `region`, etc. are not secrets), so this is a no-op for them.
 */
export function redactAIProviderConfig({ provider, config }: { provider: AIProviderName, config: AIProviderConfig }): AIProviderConfig | PublicOpenAICompatibleProviderConfig {
    if (provider !== AIProviderName.CUSTOM) {
        return config
    }
    const parsed = OpenAICompatibleProviderConfig.safeParse(config)
    if (!parsed.success) {
        // Fail closed: a stored row that no longer satisfies the schema (a direct DB write, or a
        // later tightening of a refine such as `extraBody`'s reserved keys) must not reach a
        // low-privileged reader verbatim with its `defaultHeaders`/`extraBody` attached.
        return RedactedFallbackConfig.parse(config)
    }
    const withoutSecrets = omit(parsed.data, ['defaultHeaders', 'extraBody'])
    return {
        ...withoutSecrets,
        baseUrl: originOnly(withoutSecrets.baseUrl),
    }
}

// Keeps only the two fields the pickers need and that cannot carry a credential; every other key,
// `baseUrl` included, is stripped, and a malformed field degrades to empty instead of throwing.
const RedactedFallbackConfig = z.object({
    apiKeyHeader: z.string().catch(''),
    models: z.array(ProviderModelConfig).catch([]),
}).catch({ apiKeyHeader: '', models: [] })

// A `baseUrl` that fails to parse as a URL at all has nothing safe to disambiguate rows with —
// dropping it entirely (rather than passing the raw, unparseable string through) is the fail-closed
// side of the same choice `isValidAzureResourceName`/`isValidAwsRegion` make elsewhere in this file.
function originOnly(baseUrl: string): string | undefined {
    const parsed = tryCatchSync(() => new URL(baseUrl))
    if (parsed.error !== null) {
        return undefined
    }
    return parsed.data.origin
}

export const AIProvider = z.object({
    ...BaseModelSchema,
    displayName: z.string().min(1),
    platformId: z.string(),
}).and(ProviderConfigUnion)

export type AIProvider = z.infer<typeof AIProvider>

export const AIProviderWithoutSensitiveData = z.object({
    id: z.string(),
    name: z.string(),
    provider: z.nativeEnum(AIProviderName),
    config: AIProviderConfig,
    enabledForChat: z.boolean(),
})
export type AIProviderWithoutSensitiveData = z.infer<typeof AIProviderWithoutSensitiveData>

// What `GET /v1/ai-providers` actually serves: `AIProviderWithoutSensitiveData` with `auth` held
// back, plus — for a caller that is neither the engine nor a platform admin — `redactAIProviderConfig`
// swapping a CUSTOM row's `config` for the narrower `PublicOpenAICompatibleProviderConfig` (#297).
export const AIProviderListItem = z.object({
    id: z.string(),
    name: z.string(),
    provider: z.enum(AIProviderName),
    config: z.union([AIProviderConfig, PublicOpenAICompatibleProviderConfig]),
    enabledForChat: z.boolean(),
})
export type AIProviderListItem = z.infer<typeof AIProviderListItem>

// A model described by what it can do rather than by one type. `chat` is what the chat and the
// agent step filter on; `tools` records whether the model supports function calling (reported for
// the admin and for a future consumer, not filtered on yet); the modality arrays are what the
// image and text actions read. Modalities are plain strings on purpose: a provider that reports
// one this repo has not heard of (`file`, `video`) is carried through instead of being dropped by
// an enum.
export const AIProviderModelCapabilities = z.object({
    inputModalities: z.array(z.string()),
    outputModalities: z.array(z.string()),
    chat: z.boolean(),
    tools: z.boolean(),
})
export type AIProviderModelCapabilities = z.infer<typeof AIProviderModelCapabilities>

export const AIProviderModel = z.object({
    id: z.string(),
    name: z.string(),
    // Derived from `capabilities` (see `deriveAIProviderModelType`) and kept on the wire only for
    // the pinned qadam versions that still filter the catalogue on it; new readers use
    // `capabilities`. It cannot be removed without breaking every already-published qadam, whose
    // model dropdowns read it straight from this response.
    type: z.nativeEnum(AIProviderModelType),
    capabilities: AIProviderModelCapabilities,
    // Absent when neither the provider's model list nor the operator's own catalogue says; the
    // reader then falls back to `DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS`.
    contextWindowTokens: z.int().optional(),
})
export type AIProviderModel = z.infer<typeof AIProviderModel>

// The single place the legacy `type` is derived, so the field and the capability it stands for can
// never disagree. A model that can put out an image reads as IMAGE — the rule OpenRouter and
// Bedrock already used — which keeps a pinned qadam's image/text filter behaving as before for the
// common families; OpenAI and Google image detection is now prefix/method-based and slightly
// broader than the old name list.
export function deriveAIProviderModelType({ capabilities }: { capabilities: AIProviderModelCapabilities }): AIProviderModelType {
    return capabilities.outputModalities.includes('image') ? AIProviderModelType.IMAGE : AIProviderModelType.TEXT
}

// What an operator-declared catalogue row means in capabilities. CUSTOM and Cloudflare Gateway make
// no network call — `modelType` is typed by hand, so it is the whole capability statement. `tools`
// is optimistic on a text row, matching what the pickers already offered for those rows.
export function capabilitiesFromModelType({ modelType }: { modelType: AIProviderModelType }): AIProviderModelCapabilities {
    return modelType === AIProviderModelType.IMAGE
        ? { inputModalities: ['text'], outputModalities: ['image'], chat: false, tools: false }
        : { inputModalities: ['text'], outputModalities: ['text'], chat: true, tools: true }
}

// Assembles a wire model from the capabilities a strategy knows, deriving the legacy `type`.
export function buildAIProviderModel({ id, name, capabilities, contextWindowTokens }: BuildAIProviderModelParams): AIProviderModel {
    return {
        id,
        name,
        type: deriveAIProviderModelType({ capabilities }),
        capabilities,
        ...spreadIfDefined('contextWindowTokens', contextWindowTokens),
    }
}

// Whether a model can hold a conversation — the one test the chat and the agent step model picker
// share. `chat` is set from what the provider reports (Google's `generateContent`, Mistral's
// `completion_chat`, a text output modality) and defaults to true for the models of a provider that
// reports nothing, so a new chat model is offered the day the provider lists it.
export function isChatModel({ capabilities }: { capabilities: AIProviderModelCapabilities }): boolean {
    return capabilities.chat
}

// The zero-config default and the picker's initial choice, so the model shown before anyone opens
// the picker is the one the chat actually runs. Preview builds are demoted so a stable model wins;
// otherwise the provider's own order stands, since no provider reports a release date consistently
// enough to rank on. The preview test is a best-effort heuristic on the id — no provider reports
// "this is a preview" — and an admin-set default per row is deliberately out of scope here (see
// #848).
export function pickDefaultChatModel(models: AIProviderModel[]): AIProviderModel | null {
    const chatModels = models.filter(isChatModel)
    if (chatModels.length === 0) {
        return null
    }
    return chatModels.find((model) => !PREVIEW_MODEL_ID_RE.test(model.id)) ?? chatModels[0]
}

const PREVIEW_MODEL_ID_RE = /preview|experimental/i

export const CreateAIProviderRequest = ProviderConfigUnion.and(z.object({
    enabledForChat: z.boolean().optional(),
}))
export type CreateAIProviderRequest = z.infer<typeof CreateAIProviderRequest>


export const UpdateAIProviderRequest = z.object({
    displayName: z.string().min(1).optional(),
    config: AIProviderConfig.optional(),
    auth: AIProviderAuthConfig.optional(),
    enabledForChat: z.boolean().optional(),
})
export type UpdateAIProviderRequest = z.infer<typeof UpdateAIProviderRequest>


export const GetProviderConfigResponse = z.object({
    id: z.string(),
    provider: z.nativeEnum(AIProviderName),
    config: AIProviderConfig,
    auth: AIProviderAuthConfig,
    platformId: z.string(),
})
export type GetProviderConfigResponse = z.infer<typeof GetProviderConfigResponse>


export const AIErrorResponse = z.object({
    error: z.object({
        message: z.string(),
        type: z.string(),
        code: z.string(),
    }),
})

export type AIErrorResponse = z.infer<typeof AIErrorResponse>

/**
 * Resolves the effective provider and model for capability decisions. For direct providers
 * this is the same pair that came in. For Cloudflare Gateway (which tunnels to a submodel
 * like "openai/gpt-4"), it returns the underlying provider inferred from the prefix and the
 * submodel portion of the id.
 *
 * Callers can use this to decide which provider-specific capabilities apply (e.g. which
 * web-search tool builder to use, which advancedOptions schema to render). Unrecognized
 * prefixes or missing input fall back to the raw inputs so callers never end up with a
 * wrong-but-confident answer.
 */
export function getEffectiveProviderAndModel({
    provider,
    model,
}: {
    provider: string | undefined
    model: string | undefined
}): { provider: string | undefined, model: string | undefined } {
    if (provider !== AIProviderName.CLOUDFLARE_GATEWAY || !model) {
        return { provider, model }
    }
    const split = splitCloudflareGatewayModelId(model)
    // Prefix must match map keys (lowercase); some gateways/UI send "OpenAI/...".
    const gatewaySubmodelPrefix = (split.provider ?? '').trim().toLowerCase()
    const mapped = CF_GATEWAY_SUBMODEL_TO_PROVIDER[gatewaySubmodelPrefix]
    if (!mapped) {
        return { provider, model }
    }
    return { provider: mapped, model: split.model }
}

const CF_GATEWAY_SUBMODEL_TO_PROVIDER: Record<string, AIProviderName> = {
    openai: AIProviderName.OPENAI,
    anthropic: AIProviderName.ANTHROPIC,
    'google-ai-studio': AIProviderName.GOOGLE,
    'google-vertex-ai': AIProviderName.GOOGLE,
}

/**
 * Splits a Cloudflare Gateway model ID into provider and model, i.e. "google-vertex-ai/google/gemini-2.5-pro" -> { provider: "google-vertex-ai", model: "google/gemini-2.5-pro" }.
 * @param modelId - The model ID to split.
 * @returns An object containing the provider and model.
 */
export function splitCloudflareGatewayModelId(modelId: string): {
    provider: 'google-vertex-ai'
    publisher: string
    model: string
} | {
    provider: string
    model: string
    publisher: undefined
} | {
    provider: undefined
    model: string
    publisher: undefined
} {
    const slashIndex = modelId.indexOf('/')
    if (slashIndex === -1) {
        //console.error(`Invalid model ID "${modelId}": expected format "provider/model"`)
        return {
            provider: undefined,
            model: modelId,
            publisher: undefined,
        }
    }
    // Normalize first path segment: AI Gateway and docs use lowercase (e.g. "openai/gpt-4o").
    const provider = modelId.substring(0, slashIndex).trim().toLowerCase()
    const rest = modelId.substring(slashIndex + 1)

    if (provider === 'google-vertex-ai') {
        const secondSlashIndex = rest.indexOf('/')
        if (secondSlashIndex === -1) {
            //console.error(`Invalid Google Vertex AI model ID "${modelId}": expected format "google-vertex-ai/publisher/model"`)
            return {
                provider: undefined,
                model: modelId,
                publisher: undefined,
            }
        }
        return {
            provider: 'google-vertex-ai',
            publisher: rest.substring(0, secondSlashIndex),
            model: rest.substring(secondSlashIndex + 1),
        }
    }

    return {
        provider,
        model: rest,
        publisher: undefined,
    }
}

type BuildAIProviderModelParams = {
    id: string
    name: string
    capabilities: AIProviderModelCapabilities
    contextWindowTokens?: number
}


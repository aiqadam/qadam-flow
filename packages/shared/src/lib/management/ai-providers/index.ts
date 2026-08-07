import { z } from 'zod'
import { BaseModelSchema } from '../../core/common/base-model'
import { tryCatchSync } from '../../core/common/try-catch'
import { omit } from '../../core/common/utils/object-utils'
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

export const AnthropicProviderConfig = z.object({})
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfig>

// A provider's model catalogue is operator-supplied and stored verbatim on the row, served back
// from `GET /` and held in the in-process model cache. Nothing downstream bounds it, and the
// server's body limit is 25 MB, so without these two caps one request decides how much memory a
// row costs forever. The numbers are far above any real catalogue — the longest ids in use are
// Cloudflare Gateway's `google-vertex-ai/<publisher>/<model>` form at well under 100 characters,
// and the picker these lists feed is curated by hand.
const MAX_MODEL_IDENTIFIER_LENGTH = 200
const MAX_MODELS_PER_PROVIDER = 200

export const ProviderModelConfig = z.object({
    modelId: z.string().max(MAX_MODEL_IDENTIFIER_LENGTH, formErrors.modelIdentifierTooLong),
    modelName: z.string().max(MAX_MODEL_IDENTIFIER_LENGTH, formErrors.modelIdentifierTooLong),
    modelType: z.nativeEnum(AIProviderModelType),
})
export type ProviderModelConfig = z.infer<typeof ProviderModelConfig>

export const OpenAICompatibleProviderConfig = z.object({
    apiKeyHeader: z.string(),
    baseUrl: z.string(),
    models: z.array(ProviderModelConfig).max(MAX_MODELS_PER_PROVIDER, formErrors.tooManyModels),
    defaultHeaders: z.record(z.string(), z.string()).optional(),
})
export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderConfig>


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

export const GoogleProviderConfig = z.object({})
export type GoogleProviderConfig = z.infer<typeof GoogleProviderConfig>

export const OpenAIProviderConfig = z.object({})
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfig>

export const OpenRouterProviderConfig = z.object({})
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
})
export type BedrockProviderConfig = z.infer<typeof BedrockProviderConfig>

export const MistralProviderConfig = z.object({})
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
export const PublicOpenAICompatibleProviderConfig = OpenAICompatibleProviderConfig.omit({ defaultHeaders: true }).extend({
    baseUrl: z.string().optional(),
})
export type PublicOpenAICompatibleProviderConfig = z.infer<typeof PublicOpenAICompatibleProviderConfig>

/**
 * Strips or masks the fields of a stored CUSTOM config that can themselves carry a credential:
 * `defaultHeaders` is an operator-defined record, and the second-header pattern (a signing header
 * alongside the primary `apiKeyHeader`) puts a live secret there; `baseUrl` is a free-form string
 * that can carry the same secret in its userinfo or query string, and can disclose an internal
 * hostname besides. Both are the exact fields issue #297 (echoing #277) names as leaking "the same
 * class of operator credentials". `apiKeyHeader` and `models` are not secret-shaped and stay as-is
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
        return config
    }
    const withoutHeaders = omit(parsed.data, ['defaultHeaders'])
    return {
        ...withoutHeaders,
        baseUrl: originOnly(withoutHeaders.baseUrl),
    }
}

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

export const AIProviderModel = z.object({
    id: z.string(),
    name: z.string(),
    type: z.nativeEnum(AIProviderModelType),
})
export type AIProviderModel = z.infer<typeof AIProviderModel>

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
const OPENAI_CHAT_MODELS = ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4.1', 'gpt-4.1-mini'] as const
const ANTHROPIC_CHAT_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'] as const
const GOOGLE_CHAT_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'] as const

export const ALLOWED_CHAT_MODELS_BY_PROVIDER: Partial<Record<AIProviderName, readonly string[]>> = {
    [AIProviderName.OPENAI]: OPENAI_CHAT_MODELS,
    [AIProviderName.ANTHROPIC]: ANTHROPIC_CHAT_MODELS,
    [AIProviderName.GOOGLE]: GOOGLE_CHAT_MODELS,
}

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


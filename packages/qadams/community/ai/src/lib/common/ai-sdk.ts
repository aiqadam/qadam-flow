import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createOpenAI, openai } from '@ai-sdk/openai'
import { createGoogleGenerativeAI, google } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAzure } from '@ai-sdk/azure'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { EmbeddingModel, ImageModel, LanguageModel } from 'ai'
import { ProviderOptions } from '@ai-sdk/provider-utils'
import { httpClient, HttpMethod } from '@aiqadam/qadams-common'
import { AIProviderName, AzureProviderConfig, BaseAIProviderAuthConfig, BedrockProviderAuthConfig, BedrockProviderConfig, CloudflareGatewayProviderConfig, GetProviderConfigResponse, OpenAICompatibleProviderConfig, splitCloudflareGatewayModelId } from '@aiqadam/shared'
import { createAiGateway } from 'ai-gateway-provider';
import { createAnthropic as createAnthropicGateway } from 'ai-gateway-provider/providers/anthropic';
import { createGoogleGenerativeAI as createGoogleGateway } from 'ai-gateway-provider/providers/google';
// `providerRef` is a row id or a provider name. A platform can hold several rows of the same type
// (custom endpoints), so only the id addresses one of them; the name resolves to the oldest row and
// stays supported forever, because published qadam versions are pinned exactly and build this URL
// from the enum. The ref reaches here from step input, so it is escaped rather than concatenated —
// it must stay one path segment under the engine token's authority.
async function fetchProviderConfig(params: { providerRef: string, engineToken: string, apiUrl: string }) {
    const { body } = await httpClient.sendRequest<GetProviderConfigResponse>({
        method: HttpMethod.GET,
        url: `${params.apiUrl}v1/ai-providers/${encodeURIComponent(params.providerRef)}/config`,
        headers: {
            Authorization: `Bearer ${params.engineToken}`,
        },
    })
    return body
}

type CreateAIModelParams<IsImage extends boolean = false> = {
    providerId?: string;
    provider: AIProviderName;
    modelId: string;
    engineToken: string;
    projectId: string;
    flowId: string;
    runId: string;
    apiUrl: string;
    openaiResponsesModel?: boolean;
    isImage?: IsImage;
}

export function createAIModel(params: CreateAIModelParams<false>): Promise<LanguageModel>;
export function createAIModel(params: CreateAIModelParams<true>): Promise<ImageModel>;
export async function createAIModel({
    providerId,
    provider,
    modelId,
    engineToken,
    projectId,
    flowId,
    runId,
    apiUrl,
    openaiResponsesModel = false,
    isImage,
}: CreateAIModelParams<boolean>): Promise<ImageModel | LanguageModel> {
    // The row that answered decides which SDK client can talk to it — its `auth` and `config` are
    // shaped by its own type. Switching on the name the step stored would hand, say, an OpenAI auth
    // blob to the openai-compatible factory whenever the two disagree. The stored name keeps its
    // separate job: capability gating (web search, responses API), which is decided before the
    // fetch and cannot consume an id.
    const { config, auth, platformId, provider: resolvedProvider } = await fetchProviderConfig({ providerRef: providerId ?? provider, engineToken, apiUrl });

    switch (resolvedProvider) {
        case AIProviderName.OPENAI: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const provider = createOpenAI({ apiKey })
            if (isImage) {
                return provider.imageModel(modelId)
            }
            return (openaiResponsesModel ? provider.responses(modelId) : provider.chat(modelId))
        }
        case AIProviderName.ANTHROPIC: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const provider = createAnthropic({ apiKey })
            if (isImage) {
                throw new Error(`Provider ${provider} does not support image models`)
            }
            return provider(modelId)
        }
        case AIProviderName.GOOGLE: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const provider = createGoogleGenerativeAI({ apiKey })

            return provider(modelId)
        }
        case AIProviderName.AZURE: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { resourceName, apiVersion } = config as AzureProviderConfig
            const provider = createAzure({ resourceName, apiKey, apiVersion })
            if (isImage) {
                return provider.imageModel(modelId)
            }
            return provider.chat(modelId)
        }
        case AIProviderName.CLOUDFLARE_GATEWAY: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { accountId, gatewayId,vertexProject,vertexRegion } = config as CloudflareGatewayProviderConfig
            const aigateway = createAiGateway({
                accountId: accountId,
                gateway: gatewayId,
                apiKey,
              });
            const { provider: providerPrefix, model: actualModelId, publisher } = splitCloudflareGatewayModelId(modelId)
            const cfMetadataHeaders = {
                'cf-aig-metadata': JSON.stringify({
                    projectId,
                    flowId,
                    runId,
                }),
            }

            const headers = {
                'cf-aig-authorization': `Bearer ${apiKey}`,
                ...cfMetadataHeaders,
            }
            switch (providerPrefix) {
                case 'anthropic': {
                    const anthropicProvider = createAnthropicGateway({
                        headers
                    });
                    return aigateway(anthropicProvider(actualModelId));
                }
                case 'google-ai-studio': {
                    const googleProvider = createGoogleGateway({
                        headers
                    });
                    return aigateway(googleProvider(actualModelId));
                }
                case 'google-vertex-ai': {
                    if(vertexProject && vertexRegion && publisher) {
                        const provider = createGoogleGenerativeAI({
                            apiKey,
                            baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-vertex-ai/v1/projects/${vertexProject}/locations/${vertexRegion}/publishers/${publisher}/`,
                            headers,
                        })
                        return provider(actualModelId);
                    }
                    return handleDefaultAiGatewayProvider({accountId, gatewayId, headers, isImage, modelId})
                }
                case 'openai': {
                    const openaiProvider = createOpenAI({
                        apiKey: 'no-key',
                        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai`,
                        headers,
                        fetch: (input, init) => {
                            const hdrs = new Headers(init?.headers)
                            hdrs.delete('Authorization')
                            return fetch(input, { ...init, headers: hdrs })
                        },
                    })
                    if (isImage) {
                        return openaiProvider.imageModel(actualModelId)
                    }
                    return openaiResponsesModel
                        ? openaiProvider.responses(actualModelId)
                        : openaiProvider.chat(actualModelId)
                }
                default: {
                    return handleDefaultAiGatewayProvider({accountId, gatewayId, headers, isImage, modelId})
                }
            }
        }
        case AIProviderName.BEDROCK: {
            const { accessKeyId, secretAccessKey } = auth as BedrockProviderAuthConfig
            const { region } = config as BedrockProviderConfig
            const provider = createAmazonBedrock({
                region,
                accessKeyId,
                secretAccessKey,
            })
            if (isImage) {
                return provider.imageModel(modelId)
            }
            return provider(modelId)
        }
        case AIProviderName.CUSTOM: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { apiKeyHeader, baseUrl, defaultHeaders } = config as OpenAICompatibleProviderConfig

            const customHeaders = defaultHeaders ?? {}

            const metadataHeaders: Record<string, string> = {
                'x-ap-project-id': projectId,
                'x-ap-platform-id': platformId,
                'x-ap-flow-id': flowId,
                'x-ap-run-id': runId,
            }

            const provider = createOpenAICompatible({
                name: 'openai-compatible',
                baseURL: baseUrl,
                headers: {
                    ...metadataHeaders,
                    ...customHeaders,
                    [apiKeyHeader]: apiKey,
                },
            })
            if (isImage) {
                return provider.imageModel(modelId)
            }
            return provider.chatModel(modelId)
        }
        case AIProviderName.MISTRAL: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            if (isImage) {
                throw new Error(`Provider ${AIProviderName.MISTRAL} does not support image models`)
            }
            const provider = createOpenAICompatible({
                name: 'mistral',
                baseURL: 'https://api.mistral.ai/v1',
                apiKey,
            })
            return provider.chatModel(modelId)
        }
        case AIProviderName.OPENROUTER: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const openRouterProvider = createOpenRouter({ apiKey })
            return openRouterProvider.chat(modelId) as LanguageModel
        }
        default:
            throw new Error(`Provider ${resolvedProvider} is not supported`)
    }
}



export const anthropicSearchTool = anthropic.tools.webSearch_20250305;
export const openaiSearchTool = openai.tools.webSearchPreview;
export const googleSearchTool = google.tools.googleSearch;

const EMBEDDING_DIMENSIONS = 768

const DEFAULT_EMBEDDING_MODELS: Partial<Record<AIProviderName, string>> = {
    [AIProviderName.OPENAI]: 'text-embedding-3-small',
    [AIProviderName.GOOGLE]: 'text-embedding-004',
    [AIProviderName.AZURE]: 'text-embedding-3-small',
    [AIProviderName.OPENROUTER]: 'openai/text-embedding-3-small',
}

const OPENAI_EMBEDDING_PROVIDER_OPTIONS = {
    openai: { dimensions: EMBEDDING_DIMENSIONS },
}

type CreateEmbeddingModelParams = {
    providerId?: string
    provider: AIProviderName
    engineToken: string
    apiUrl: string
}

// The second name-resolving entry point into the config route, and the one that is easy to miss:
// knowledge-base tools reach it from `run-agent`. It takes a ref for the same reasons
// `createAIModel` does, and reads the answering row's type rather than the stored name.
export async function createEmbeddingModel({
    providerId,
    provider,
    engineToken,
    apiUrl,
}: CreateEmbeddingModelParams): Promise<CreateEmbeddingModelResult> {
    const { config, auth, provider: resolvedProvider } = await fetchProviderConfig({ providerRef: providerId ?? provider, engineToken, apiUrl })

    const embeddingModelId = DEFAULT_EMBEDDING_MODELS[resolvedProvider]
    if (!embeddingModelId) {
        throw new Error(`Provider ${resolvedProvider} does not have a default embedding model configured`)
    }

    const { apiKey } = auth as BaseAIProviderAuthConfig

    switch (resolvedProvider) {
        case AIProviderName.OPENAI: {
            const p = createOpenAI({ apiKey })
            return { model: p.embeddingModel(embeddingModelId), embeddingModelId, providerOptions: OPENAI_EMBEDDING_PROVIDER_OPTIONS }
        }
        case AIProviderName.GOOGLE: {
            const p = createGoogleGenerativeAI({ apiKey })
            return { model: p.textEmbeddingModel(embeddingModelId), embeddingModelId, providerOptions: {} }
        }
        case AIProviderName.AZURE: {
            const { resourceName, apiVersion } = config as AzureProviderConfig
            const p = createAzure({ resourceName, apiKey, apiVersion })
            return { model: p.embeddingModel(embeddingModelId), embeddingModelId, providerOptions: OPENAI_EMBEDDING_PROVIDER_OPTIONS }
        }
        case AIProviderName.OPENROUTER: {
            const openRouterProvider = createOpenRouter({ apiKey })
            return { model: openRouterProvider.textEmbeddingModel(embeddingModelId), embeddingModelId, providerOptions: OPENAI_EMBEDDING_PROVIDER_OPTIONS }
        }
        default:
            throw new Error(`Provider ${resolvedProvider} does not support embedding models`)
    }
}

type CreateEmbeddingModelResult = {
    model: EmbeddingModel
    embeddingModelId: string
    providerOptions: ProviderOptions
}

const handleDefaultAiGatewayProvider = ({accountId, gatewayId, headers, isImage, modelId}: {
    accountId: string;
    gatewayId: string;
    headers: Record<string, string>;
    isImage?: boolean;
    modelId: string;
})=>{
    const provider = createOpenAICompatible({
        name: 'cloudflare',
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`,
        headers,
    })
    if (isImage) {
        return provider.imageModel(modelId)
    }
    return provider.chatModel(modelId)
}

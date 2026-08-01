import { chatAiUtils } from '@aiqadam/server-utils'
import {
    AIProviderConfig,
    AIProviderModelType,
    AIProviderName,
    ErrorCode,
    isNil,
    QadamFlowError,
    tryCatch,
} from '@aiqadam/shared'
import { LanguageModel } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { aiProviderService } from '../ai/ai-provider-service'

export const chatModel = {
    async resolve({ platformId, modelName, log }: ResolveParams): Promise<ResolvedChatModel> {
        const chatProvider = await aiProviderService(log).getChatProvider({ platformId })
        if (isNil(chatProvider)) {
            // AI_REQUEST_NOT_SUPPORTED rather than AI_PROVIDER_NOT_SUPPORTED: the latter's params
            // require a `provider` name and here there is no provider at all to name, so it would
            // have to be filled with a placeholder. This code carries a free-text `message` the
            // chat UI can render verbatim. Unmapped codes fall through to 400 in error-handler.ts,
            // so a missing provider is reported as a stated cause and never as a 500.
            throw new QadamFlowError({
                code: ErrorCode.AI_REQUEST_NOT_SUPPORTED,
                params: {
                    message: 'No AI provider is enabled for chat on this platform. An admin must enable one in the platform AI settings before the assistant can answer.',
                },
            })
        }

        const modelId = modelName
            ?? firstTextModelId(chatProvider.config)
            ?? await firstTextModelFromProvider({ platformId, provider: chatProvider.provider, log })
        if (isNil(modelId)) {
            // Only reached when the provider itself reports no text model. Guessing a default here
            // would hardcode a model name, which is the thing this feature exists not to do.
            throw new QadamFlowError({
                code: ErrorCode.AI_MODEL_NOT_SUPPORTED,
                params: { provider: chatProvider.provider, model: modelName ?? '' },
            })
        }

        return {
            model: chatAiUtils.createChatModel({
                provider: chatProvider.provider,
                auth: chatProvider.auth,
                config: chatProvider.config,
                modelId,
            }),
            modelId,
            provider: chatProvider.provider,
        }
    },
}

// Without this the common case does not work at all: only the gateway-style providers store a
// model catalogue in their config, and no chat UI component ever calls `setModelName` — nothing
// in `packages/web/src/app/routes/chat-with-ai/` does — so a platform configured with OpenAI,
// Anthropic or Google reaches here with `modelName` null and no catalogue, and the very first
// message of a fresh install would fail. `listModels` is not a per-turn network call: it is
// memoised in `ai-provider-service.ts` per provider row, invalidated when that row is edited, and
// cleared once a day — so this costs one lookup per provider per instance per day. A provider that is unreachable throws, and
// that is the right answer — the chat cannot run against a provider it cannot talk to.
async function firstTextModelFromProvider({ platformId, provider, log }: FirstTextModelParams): Promise<string | null> {
    const { data: models, error } = await tryCatch(() => aiProviderService(log).listModels(platformId, provider))
    if (!isNil(error) || isNil(models)) {
        throw new QadamFlowError({
            code: ErrorCode.AI_REQUEST_NOT_SUPPORTED,
            params: {
                message: 'The configured AI provider could not be reached to list its models. Check the provider settings in the platform AI configuration.',
            },
        })
    }
    return models.find((model) => model.type === AIProviderModelType.TEXT)?.id ?? null
}

// Only the gateway-style providers carry a model catalogue in their config; the rest have to be
// asked over the network, which is what `firstTextModelFromProvider` is for.
function firstTextModelId(config: AIProviderConfig): string | null {
    if (!('models' in config)) {
        return null
    }
    const textModel = config.models.find((model) => model.modelType === AIProviderModelType.TEXT)
    return textModel?.modelId ?? null
}

type FirstTextModelParams = {
    platformId: string
    provider: AIProviderName
    log: FastifyBaseLogger
}

type ResolveParams = {
    platformId: string
    modelName: string | null | undefined
    log: FastifyBaseLogger
}

export type ResolvedChatModel = {
    model: LanguageModel
    modelId: string
    provider: AIProviderName
}

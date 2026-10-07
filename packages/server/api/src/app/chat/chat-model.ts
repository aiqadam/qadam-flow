import { SharedV4ProviderOptions } from '@ai-sdk/provider'
import { chatAiUtils } from '@aiqadam/server-utils'
import {
    AIProviderConfig,
    AIProviderModel,
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

        const chosen = isNil(modelName)
            ? firstTextModelFromConfig(chatProvider.config) ?? await firstTextModelFromProvider({ platformId, providerId: chatProvider.id, log })
            : await validateRequestedModel({ platformId, providerId: chatProvider.id, modelName, log })
        if (isNil(chosen)) {
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
                modelId: chosen.modelId,
            }),
            modelId: chosen.modelId,
            contextWindowTokens: chosen.contextWindowTokens,
            provider: chatProvider.provider,
            reasoningProviderOptions: chatAiUtils.buildProviderOptions({
                provider: chatProvider.provider,
                modelId: chosen.modelId,
                reasoning: 'reasoning' in chatProvider.config ? chatProvider.config.reasoning : undefined,
            }),
        }
    },
}

// Without this the common case does not work at all: only the gateway-style providers store a
// model catalogue in their config, and a user who has never opened the chat model picker (#377)
// reaches here with `modelName` null and no catalogue — so a platform configured with OpenAI,
// Anthropic or Google would otherwise fail on the very first message of a fresh install.
// `listModels` is not a per-turn network call: it is
// memoised in `ai-provider-service.ts` per provider row, invalidated when that row is edited, and
// cleared once a day — so this costs one lookup per provider per instance per day. A provider that is unreachable throws, and
// that is the right answer — the chat cannot run against a provider it cannot talk to.
async function firstTextModelFromProvider({ platformId, providerId, log }: FirstTextModelParams): Promise<ChosenModel | null> {
    const { data: models, error } = await tryCatch(() => aiProviderService(log).listModels({ platformId, ref: providerId }))
    if (!isNil(error) || isNil(models)) {
        throw new QadamFlowError({
            code: ErrorCode.AI_REQUEST_NOT_SUPPORTED,
            params: {
                message: 'The configured AI provider could not be reached to list its models. Check the provider settings in the platform AI configuration.',
            },
        })
    }
    const textModel = models.find((model) => model.type === AIProviderModelType.TEXT)
    return isNil(textModel) ? null : fromListedModel(textModel)
}

// A caller-supplied `modelName` is a value a chat user picked through the model picker (#377) — it
// must be checked against the provider's own catalogue before it reaches `createChatModel`, or an
// authenticated platform user could pin an arbitrary string as the model id: the most expensive
// model the operator's key can reach (the frontend's own allow-list is not enforced here otherwise),
// or for GOOGLE/AZURE, a string interpolated into the request *path* the AI SDK builds. `listModels`
// is the same memoised lookup `firstTextModelFromProvider` already uses, so a previously-resolved
// pick costs a cache hit rather than a fresh network call. Returns null rather than throwing so the
// caller folds an invalid pick into the same AI_MODEL_NOT_SUPPORTED path as "provider has no model".
async function validateRequestedModel({ platformId, providerId, modelName, log }: ValidateRequestedModelParams): Promise<ChosenModel | null> {
    const { data: models, error } = await tryCatch(() => aiProviderService(log).listModels({ platformId, ref: providerId }))
    if (!isNil(error) || isNil(models)) {
        throw new QadamFlowError({
            code: ErrorCode.AI_REQUEST_NOT_SUPPORTED,
            params: {
                message: 'The configured AI provider could not be reached to list its models. Check the provider settings in the platform AI configuration.',
            },
        })
    }
    const match = models.find((model) => model.id === modelName && model.type === AIProviderModelType.TEXT)
    return isNil(match) ? null : fromListedModel(match)
}

// Only the gateway-style providers carry a model catalogue in their config; the rest have to be
// asked over the network, which is what `firstTextModelFromProvider` is for.
function firstTextModelFromConfig(config: AIProviderConfig): ChosenModel | null {
    if (!('models' in config)) {
        return null
    }
    const textModel = config.models.find((model) => model.modelType === AIProviderModelType.TEXT)
    return isNil(textModel) ? null : { modelId: textModel.modelId, contextWindowTokens: textModel.contextWindowTokens ?? null }
}

function fromListedModel(model: AIProviderModel): ChosenModel {
    return { modelId: model.id, contextWindowTokens: model.contextWindowTokens ?? null }
}

type FirstTextModelParams = {
    platformId: string
    providerId: string
    log: FastifyBaseLogger
}

type ValidateRequestedModelParams = {
    platformId: string
    providerId: string
    modelName: string
    log: FastifyBaseLogger
}

type ResolveParams = {
    platformId: string
    modelName: string | null | undefined
    log: FastifyBaseLogger
}

type ChosenModel = {
    modelId: string
    contextWindowTokens: number | null
}

export type ResolvedChatModel = {
    model: LanguageModel
    modelId: string
    // Null when neither the provider's model list nor the operator's catalogue says.
    contextWindowTokens: number | null
    provider: AIProviderName
    // Kept apart from `model` on purpose: the compaction summariser uses the same model and must
    // never reason, so the options travel only to the one call that is allowed them (#566). Null
    // when the row has not opted in.
    reasoningProviderOptions: SharedV4ProviderOptions | null
}

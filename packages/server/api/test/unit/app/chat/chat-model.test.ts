import { AIProviderModelType, AIProviderName, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit rather than integration on purpose: the branch that matters — falling back to the
// provider's own model catalogue — cannot be reached hermetically through the HTTP layer. Only
// the two gateway-style providers store a catalogue in their config, and for those the fallback
// is never consulted; every provider that does need it (OpenAI, Anthropic, Google, Azure) resolves
// models over the network to a host the test cannot point at a fixture. Mocking the service is the
// only way to exercise the path without a third-party call from CI.
const getChatProvider = vi.fn()
const listModels = vi.fn()
const createChatModel = vi.fn((_args: unknown) => 'language-model')

vi.mock('../../../../src/app/ai/ai-provider-service', () => ({
    aiProviderService: () => ({ getChatProvider, listModels }),
}))
vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        chatAiUtils: { createChatModel: (args: unknown) => createChatModel(args), buildProviderOptions: actual.chatAiUtils.buildProviderOptions },
    }
})

import { chatModel } from '../../../../src/app/chat/chat-model'

const log = { error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

const CHAT_CAPABILITIES = { inputModalities: ['text'], outputModalities: ['text'], chat: true, tools: true }
const IMAGE_CAPABILITIES = { inputModalities: ['text'], outputModalities: ['image'], chat: false, tools: false }

function provider(config: Record<string, unknown>, name = AIProviderName.CUSTOM) {
    return { id: 'provider-row-id', provider: name, config, auth: { apiKey: 'k' }, platformId: 'plat' }
}

async function resolveError(modelName: string | null): Promise<QadamFlowError> {
    const error = await chatModel.resolve({ platformId: 'plat', modelName, log })
        .then(() => null, (err: unknown) => err)
    expect(error).toBeInstanceOf(QadamFlowError)
    return error as QadamFlowError
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('chatModel.resolve', () => {
    it('states the cause when no provider is enabled for chat', async () => {
        getChatProvider.mockResolvedValue(null)

        const error = await resolveError(null)

        expect(error.error.code).toBe('AI_REQUEST_NOT_SUPPORTED')
        expect(listModels).not.toHaveBeenCalled()
    })

    it('prefers the model the conversation pinned over anything else, once the provider vouches for it', async () => {
        getChatProvider.mockResolvedValue(provider({ models: [{ modelId: 'from-config', modelType: AIProviderModelType.TEXT }] }))
        listModels.mockResolvedValue([
            { id: 'from-config', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES },
            { id: 'pinned-model', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES },
        ])

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'pinned-model', log })

        expect(resolved.modelId).toBe('pinned-model')
    })

    // The gap #377's app-sec review caught: before this, any string reaching `resolve` as
    // `modelName` was trusted outright — a chat user could pin an arbitrary id, billed to
    // whichever model that string happened to name on the operator's provider. A pinned model
    // must now be a real, chat-capable entry in this provider's own catalogue.
    it('refuses a pinned model that is not in the provider catalogue, rather than trusting the caller', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'the-only-real-model', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES }])

        const error = await resolveError('attacker-supplied-model-id')

        expect(error.error.code).toBe('AI_MODEL_NOT_SUPPORTED')
    })

    it('refuses a pinned model that exists but is not a chat model', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'an-image-model', type: AIProviderModelType.IMAGE, capabilities: IMAGE_CAPABILITIES }])

        const error = await resolveError('an-image-model')

        expect(error.error.code).toBe('AI_MODEL_NOT_SUPPORTED')
    })

    // #848: the filter is the capability, not the legacy type. An embedding-style model derives as
    // TEXT (it outputs no image) but cannot chat, so a type check would have let it through and a
    // capability check must refuse it.
    it('refuses a pinned model that is TEXT-typed but cannot chat', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'text-embedding-3-small', type: AIProviderModelType.TEXT, capabilities: { inputModalities: ['text'], outputModalities: [], chat: false, tools: false } }])

        const error = await resolveError('text-embedding-3-small')

        expect(error.error.code).toBe('AI_MODEL_NOT_SUPPORTED')
    })

    it('reports no model when the provider lists only a TEXT-typed model that cannot chat', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'text-embedding-3-small', type: AIProviderModelType.TEXT, capabilities: { inputModalities: ['text'], outputModalities: [], chat: false, tools: false } }])

        const error = await resolveError(null)

        expect(error.error.code).toBe('AI_MODEL_NOT_SUPPORTED')
    })

    it('takes the first chat model from the stored catalogue without asking the provider', async () => {
        getChatProvider.mockResolvedValue(provider({
            models: [
                { modelId: 'an-image-model', modelType: AIProviderModelType.IMAGE },
                { modelId: 'from-config', modelType: AIProviderModelType.TEXT },
            ],
        }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.modelId).toBe('from-config')
        expect(listModels).not.toHaveBeenCalled()
    })

    it('carries the context window the operator entered on the catalogue entry', async () => {
        getChatProvider.mockResolvedValue(provider({
            models: [{ modelId: 'qwen3-32b', modelType: AIProviderModelType.TEXT, contextWindowTokens: 32_768 }],
        }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.contextWindowTokens).toBe(32_768)
    })

    it('carries the context window the provider reported for a pinned model, and null when it reported none', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([
            { id: 'sized', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES, contextWindowTokens: 1_048_576 },
            { id: 'unsized', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES },
        ])

        const sized = await chatModel.resolve({ platformId: 'plat', modelName: 'sized', log })
        const unsized = await chatModel.resolve({ platformId: 'plat', modelName: 'unsized', log })

        expect(sized.contextWindowTokens).toBe(1_048_576)
        expect(unsized.contextWindowTokens).toBeNull()
    })

    // The case that makes chat work at all on OpenAI/Anthropic/Google: no pinned model, no stored
    // catalogue, so the provider itself is asked.
    it('asks the provider for a model when the config carries no catalogue', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([
            { id: 'an-image-model', type: AIProviderModelType.IMAGE, capabilities: IMAGE_CAPABILITIES },
            { id: 'from-provider', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES },
        ])

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.modelId).toBe('from-provider')
        // The row it already holds, not the provider name — with two rows of one name the name
        // does not identify a provider, and re-resolving by it can reach a different one.
        expect(listModels).toHaveBeenCalledWith({ platformId: 'plat', ref: 'provider-row-id' })
    })

    // #566. The options are built for the model this run resolved, because the Anthropic shape
    // depends on the model id, and they stay off the `model` object the summariser also uses.
    it('builds the reasoning options from the row\'s setting and the model it resolved', async () => {
        getChatProvider.mockResolvedValue(provider({ reasoning: { enabled: true, budgetTokens: 2_048 } }, AIProviderName.ANTHROPIC))
        listModels.mockResolvedValue([{ id: 'claude-sonnet-4-5', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES }])

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.reasoningProviderOptions).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 2_048 } } })
        expect(resolved.model).toBe('language-model')
    })

    it('has no reasoning options for a row that did not opt in', async () => {
        getChatProvider.mockResolvedValue(provider({}, AIProviderName.ANTHROPIC))
        listModels.mockResolvedValue([{ id: 'claude-sonnet-4-5', type: AIProviderModelType.TEXT, capabilities: CHAT_CAPABILITIES }])

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.reasoningProviderOptions).toBeNull()
    })

    it('names the missing model when the provider reports no chat model at all', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'an-image-model', type: AIProviderModelType.IMAGE, capabilities: IMAGE_CAPABILITIES }])

        const error = await resolveError(null)

        expect(error.error.code).toBe('AI_MODEL_NOT_SUPPORTED')
    })

    // An unreachable provider must read as a configuration problem the operator can act on, not as
    // whatever the transport threw — and never as a 500.
    it('reports an unreachable provider as a stated cause, and leaks nothing from the transport error', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockRejectedValue(new Error('connect ECONNREFUSED with apiKey=sk-secret'))

        const error = await resolveError(null)

        expect(error.error.code).toBe('AI_REQUEST_NOT_SUPPORTED')
        expect(JSON.stringify(error.error.params)).not.toContain('sk-secret')
    })
})

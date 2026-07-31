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
vi.mock('@aiqadam/server-utils', () => ({
    chatAiUtils: { createChatModel: (args: unknown) => createChatModel(args) },
}))

import { chatModel } from '../../../../src/app/chat/chat-model'

const log = { error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

function provider(config: Record<string, unknown>, name = AIProviderName.CUSTOM) {
    return { provider: name, config, auth: { apiKey: 'k' }, platformId: 'plat' }
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

    it('prefers the model the conversation pinned over anything else', async () => {
        getChatProvider.mockResolvedValue(provider({ models: [{ modelId: 'from-config', modelType: AIProviderModelType.TEXT }] }))

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: 'pinned-model', log })

        expect(resolved.modelId).toBe('pinned-model')
        expect(listModels).not.toHaveBeenCalled()
    })

    it('takes the first text model from the stored catalogue without asking the provider', async () => {
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

    // The case that makes chat work at all on OpenAI/Anthropic/Google: no pinned model, no stored
    // catalogue, so the provider itself is asked.
    it('asks the provider for a model when the config carries no catalogue', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([
            { id: 'an-image-model', type: AIProviderModelType.IMAGE },
            { id: 'from-provider', type: AIProviderModelType.TEXT },
        ])

        const resolved = await chatModel.resolve({ platformId: 'plat', modelName: null, log })

        expect(resolved.modelId).toBe('from-provider')
        expect(listModels).toHaveBeenCalledWith('plat', AIProviderName.AZURE)
    })

    it('names the missing model when the provider reports no text model at all', async () => {
        getChatProvider.mockResolvedValue(provider({ resourceName: 'res' }, AIProviderName.AZURE))
        listModels.mockResolvedValue([{ id: 'an-image-model', type: AIProviderModelType.IMAGE }])

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

import { AIProviderModelType } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stubs the SSRF-filtered client rather than `@aiqadam/qadams-common`'s `httpClient`: that import
// is what #276 removed, and a mock of it would have gone on passing while the provider talked to
// the real network through an unfiltered axios instance.
const { axiosRequest } = vi.hoisted(() => ({ axiosRequest: vi.fn() }))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        safeHttp: { ...actual.safeHttp, axios: { request: axiosRequest } },
    }
})

import { googleProvider } from '../../../../../src/app/ai/providers/google-provider'

function respondWith(data: unknown): void {
    axiosRequest.mockResolvedValue({ status: 200, statusText: 'OK', data, headers: {} })
}

describe('googleProvider.listModels', () => {
    beforeEach(() => {
        axiosRequest.mockReset()
    })

    it('strips the models/ prefix from every emitted model id', async () => {
        respondWith({
            models: [
                { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/imagen-3.0-generate', displayName: 'Imagen 3', supportedGenerationMethods: ['predict'] },
            ],
        })

        const models = await googleProvider.listModels({ apiKey: 'test-key' }, {})

        for (const model of models) {
            expect(model.id.startsWith('models/')).toBe(false)
        }
    })

    // `supportedGenerationMethods` is what replaces the old hardcoded chat allow-list: a model
    // Google adds or retires is offered or hidden the day Google reports it (#848).
    it('reads a chat model from its generateContent method', async () => {
        respondWith({
            models: [
                { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
            ],
        })

        const models = await googleProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models[0]).toMatchObject({
            id: 'gemini-3.8-flash',
            type: AIProviderModelType.TEXT,
            capabilities: { outputModalities: ['text'], chat: true },
        })
    })

    it('reads an image generator from its predict method', async () => {
        respondWith({
            models: [
                // Deliberately free of the substring "image", so only the `predict` method can
                // drive the IMAGE classification (imagen ids would match the name rule too).
                { name: 'models/veo-3-generate', displayName: 'Veo 3', supportedGenerationMethods: ['predict'] },
            ],
        })

        const models = await googleProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models[0]).toMatchObject({
            type: AIProviderModelType.IMAGE,
            capabilities: { outputModalities: ['image'], chat: false },
        })
    })

    it('does not offer an embedding model to the chat', async () => {
        respondWith({
            models: [
                { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
            ],
        })

        const models = await googleProvider.listModels({ apiKey: 'test-key' }, {})

        expect(models[0].capabilities.chat).toBe(false)
        expect(models[0].capabilities.outputModalities).toEqual([])
    })
})

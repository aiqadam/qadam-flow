import { describe, expect, it } from 'vitest'
import {
    AIProviderModel,
    AIProviderModelCapabilities,
    AIProviderModelType,
    buildAIProviderModel,
    capabilitiesFromModelType,
    deriveAIProviderModelType,
    pickDefaultChatModel,
} from '../../src'

const chatCapabilities: AIProviderModelCapabilities = { inputModalities: ['text'], outputModalities: ['text'], chat: true, tools: true }
const imageCapabilities: AIProviderModelCapabilities = { inputModalities: ['text'], outputModalities: ['image'], chat: false, tools: false }

const chatModel = (id: string): AIProviderModel => ({ id, name: id, type: AIProviderModelType.TEXT, capabilities: chatCapabilities })
const imageModel = (id: string): AIProviderModel => ({ id, name: id, type: AIProviderModelType.IMAGE, capabilities: imageCapabilities })

describe('deriveAIProviderModelType', () => {
    it('reads an image output as IMAGE, whatever else the model can do', () => {
        expect(deriveAIProviderModelType({ capabilities: imageCapabilities })).toBe(AIProviderModelType.IMAGE)
        expect(deriveAIProviderModelType({ capabilities: { ...chatCapabilities, outputModalities: ['image', 'text'] } })).toBe(AIProviderModelType.IMAGE)
    })

    it('reads anything else as TEXT, so a pinned qadam keeps seeing the same catalogue', () => {
        expect(deriveAIProviderModelType({ capabilities: chatCapabilities })).toBe(AIProviderModelType.TEXT)
        expect(deriveAIProviderModelType({ capabilities: { inputModalities: ['text'], outputModalities: [], chat: false, tools: false } })).toBe(AIProviderModelType.TEXT)
    })
})

describe('capabilitiesFromModelType', () => {
    it('makes a TEXT operator row a chat model and an IMAGE row an image generator', () => {
        expect(capabilitiesFromModelType({ modelType: AIProviderModelType.TEXT })).toEqual(chatCapabilities)
        expect(capabilitiesFromModelType({ modelType: AIProviderModelType.IMAGE })).toEqual(imageCapabilities)
    })
})

describe('buildAIProviderModel', () => {
    it('derives the legacy type from the capabilities', () => {
        expect(buildAIProviderModel({ id: 'dall-e-3', name: 'DALL-E 3', capabilities: imageCapabilities }).type).toBe(AIProviderModelType.IMAGE)
    })

    it('omits contextWindowTokens rather than sending undefined', () => {
        expect(buildAIProviderModel({ id: 'm', name: 'M', capabilities: chatCapabilities })).not.toHaveProperty('contextWindowTokens')
        expect(buildAIProviderModel({ id: 'm', name: 'M', capabilities: chatCapabilities, contextWindowTokens: 32_768 }).contextWindowTokens).toBe(32_768)
    })
})

describe('pickDefaultChatModel', () => {
    it('is null when the provider lists no chat model', () => {
        expect(pickDefaultChatModel([imageModel('dall-e-3')])).toBeNull()
    })

    it('prefers a stable model over a preview one, then the provider order', () => {
        expect(pickDefaultChatModel([chatModel('gemini-3.8-flash-preview'), chatModel('gemini-3.7-flash')])?.id).toBe('gemini-3.7-flash')
        expect(pickDefaultChatModel([chatModel('gpt-5.5'), chatModel('gpt-5.4')])?.id).toBe('gpt-5.5')
    })
})

import { AIProviderModelType, AIProviderName, AzureProviderConfig, redactAIProviderConfig } from '../../src/lib/management/ai-providers'

// #297 (echoing #277): a CUSTOM row's `baseUrl` and `defaultHeaders` can each carry the same class
// of operator credential a low-privileged reader must not see — `defaultHeaders` directly, `baseUrl`
// via userinfo or a query-string parameter. `apiKeyHeader` and `models` are not secret-shaped and
// must survive untouched, since the builder's model picker and the qadam's own picker read
// `baseUrl`/`apiKeyHeader` off a redacted response to disambiguate two rows of the same provider.
describe('redactAIProviderConfig', () => {
    it('drops defaultHeaders and masks baseUrl down to its origin for a CUSTOM provider', () => {
        const redacted = redactAIProviderConfig({
            provider: AIProviderName.CUSTOM,
            config: {
                baseUrl: 'https://user:secret-token@api.example.com/v1/chat?api_key=leaked',
                apiKeyHeader: 'Authorization',
                models: [],
                defaultHeaders: { 'X-Secondary-Auth': 'Bearer leaked-too' },
            },
        })

        expect(redacted).toEqual({
            baseUrl: 'https://api.example.com',
            apiKeyHeader: 'Authorization',
            models: [],
        })
    })

    it('keeps apiKeyHeader and models exactly as stored', () => {
        const models = [{ modelId: 'm', modelName: 'M', modelType: AIProviderModelType.TEXT }]
        const redacted = redactAIProviderConfig({
            provider: AIProviderName.CUSTOM,
            config: {
                baseUrl: 'https://api.example.com',
                apiKeyHeader: 'X-Custom-Key',
                models,
            },
        })

        expect(redacted).toMatchObject({ apiKeyHeader: 'X-Custom-Key', models })
    })

    it('drops baseUrl entirely rather than passing an unparseable value through', () => {
        const redacted = redactAIProviderConfig({
            provider: AIProviderName.CUSTOM,
            config: {
                baseUrl: 'not-a-url',
                apiKeyHeader: 'Authorization',
                models: [],
            },
        })

        expect(redacted).toEqual({ apiKeyHeader: 'Authorization', models: [] })
    })

    it('preserves a query-free origin unchanged', () => {
        const redacted = redactAIProviderConfig({
            provider: AIProviderName.CUSTOM,
            config: {
                baseUrl: 'https://api.example.com',
                apiKeyHeader: 'Authorization',
                models: [],
            },
        })

        expect(redacted).toMatchObject({ baseUrl: 'https://api.example.com' })
    })

    // Every provider other than CUSTOM has no field shaped like a credential in its `config` at
    // all — `resourceName` is host-injection-hardened separately (#276) but is not a secret value —
    // so redaction must be a no-op for them rather than stripping something that was never sensitive.
    it('is a no-op for a non-CUSTOM provider', () => {
        const config = { resourceName: 'my-resource', apiVersion: undefined }
        const redacted = redactAIProviderConfig({ provider: AIProviderName.AZURE, config: AzureProviderConfig.parse(config) })

        expect(redacted).toEqual(config)
    })
})

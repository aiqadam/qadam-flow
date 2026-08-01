import { AIProviderModel, AIProviderModelType, AzureProviderAuthConfig, AzureProviderConfig, DEFAULT_AZURE_API_VERSION, INVALID_AZURE_RESOURCE_NAME_MESSAGE, isValidAzureResourceName } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'
import { providerHttp } from './provider-http'

export const azureProvider: AIProviderStrategy<AzureProviderAuthConfig, AzureProviderConfig> = {
    name: 'Azure OpenAI',
    async validateConnection(authConfig: AzureProviderAuthConfig, config: AzureProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await azureProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: AzureProviderAuthConfig, config: AzureProviderConfig): Promise<AIProviderModel[]> {
        // `AzureProviderConfig` now rejects a `resourceName` that is not one, but the row this
        // reads was written before that and is never re-parsed on the way out of the database —
        // `listModels` is handed `aiProvider.config` verbatim. Checking at the sink is what stops
        // a value stored under the old schema from still building the host and shipping the
        // `api-key` header to it (#276).
        if (!isValidAzureResourceName(config.resourceName)) {
            throw new Error(INVALID_AZURE_RESOURCE_NAME_MESSAGE)
        }
        const endpoint = `https://${config.resourceName}.openai.azure.com`
        const apiKey = authConfig.apiKey
        const apiVersion = config.apiVersion ?? DEFAULT_AZURE_API_VERSION

        if (!apiKey) {
            return []
        }

        const { data } = await providerHttp.sendJson<{ data: AzureModel[] }>({
            url: `${endpoint}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`,
            method: 'GET',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
        })

        return data.map((deployment: AzureModel) => ({
            id: deployment.name,
            name: deployment.name,
            type: AIProviderModelType.TEXT,
        }))
    },
}

type AzureModel = {
    name: string
}

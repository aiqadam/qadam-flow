import {
    AIProviderAuthConfig,
    AIProviderConfig,
    AIProviderModel,
    AIProviderName,
    AIProviderWithoutSensitiveData,
    apId,
    CreateAIProviderRequest,
    ErrorCode,
    GetProviderConfigResponse,
    isNil,
    PlatformId,
    QadamFlowError,
    spreadIfDefined,
    tryCatch,
    UpdateAIProviderRequest,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import cron from 'node-cron'
import { QueryFailedError } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { encryptUtils } from '../helper/encryption'
import { AIProviderEntity, AIProviderSchema } from './ai-provider-entity'
import { aiProviders } from './providers'

const aiProviderRepo = repoFactory<AIProviderSchema>(AIProviderEntity)

const modelsCache = new Map<string, AIProviderModel[]>()

export const aiProviderService = (log: FastifyBaseLogger) => ({
    async setup(): Promise<void> {
        cron.schedule('0 0 * * *', () => {
            log.info('Clearing AI provider models cache')
            modelsCache.clear()
        })
    },

    async listProviders(platformId: PlatformId): Promise<AIProviderWithoutSensitiveData[]> {
        const configuredProviders = await aiProviderRepo().findBy({ platformId })

        return configuredProviders.map((p): AIProviderWithoutSensitiveData => ({
            id: p.id,
            name: p.displayName,
            provider: p.provider,
            config: p.config,
            enabledForChat: p.enabledForChat ?? false,
        }))
    },

    async listModels(platformId: PlatformId, provider: AIProviderName): Promise<AIProviderModel[]> {
        const aiProvider = await findProviderOrThrow({ platformId, provider })

        // Keyed on the row, not on the credentials: two configs can share an api key and still
        // point at different endpoints (an Azure resource name, a base url), and a key in a
        // process-wide map is a secret living somewhere it has no reason to be. `updated` moves
        // whenever the config or the credentials are edited, which invalidates the entry.
        const cacheKey = `${aiProvider.id}-${String(aiProvider.updated)}`
        const config = aiProvider.config
        if (modelsCache.has(cacheKey) && !('models' in config)) {
            return modelsCache.get(cacheKey)!
        }

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)
        const data = await aiProviders[provider].listModels(auth, config)

        modelsCache.set(cacheKey, data.map(model => ({
            id: model.id,
            name: model.name,
            type: model.type,
        })))

        return modelsCache.get(cacheKey)!
    },

    async create(platformId: PlatformId, request: CreateAIProviderRequest): Promise<void> {
        await this.validateProviderCredentials(request.provider, request.auth, request.config)
        const newProvider = {
            id: apId(),
            auth: await encryptUtils.encryptObject(request.auth),
            config: request.config,
            provider: request.provider,
            displayName: request.displayName,
            enabledForChat: request.enabledForChat ?? false,
            platformId,
        }

        const { error } = await tryCatch(async () => {
            if (!newProvider.enabledForChat) {
                await aiProviderRepo().insert(newProvider)
                return
            }
            await aiProviderRepo().manager.transaction(async (manager) => {
                await manager.update(AIProviderEntity, { platformId }, { enabledForChat: false })
                await manager.insert(AIProviderEntity, newProvider)
            })
        })

        if (isNil(error)) {
            return
        }
        if (isUniqueViolation(error)) {
            throw new QadamFlowError({
                code: ErrorCode.EXISTING_AI_PROVIDER,
                params: {
                    provider: request.provider,
                    // The dialog renders params.message, and what it used to render here was the
                    // raw Postgres message including the index name.
                    message: `A ${aiProviders[request.provider].name} provider is already configured for this platform`,
                },
            })
        }
        throw error
    },
    async update(platformId: PlatformId, providerId: string, request: UpdateAIProviderRequest): Promise<void> {
        const aiProvider = await aiProviderRepo().findOneBy({
            platformId,
            id: providerId,
        })
        if (isNil(aiProvider)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: providerId, entityType: 'AIProvider' },
            })
        }

        const encryptedAuth = !isNil(request.auth) ? await encryptUtils.encryptObject(request.auth) : undefined
        const updates = {
            ...spreadIfDefined('auth', encryptedAuth),
            ...spreadIfDefined('config', request.config),
            ...spreadIfDefined('enabledForChat', request.enabledForChat),
            ...spreadIfDefined('displayName', request.displayName),
        }

        // Every field is optional, so a request can now carry nothing at all. TypeORM rejects an
        // empty update, and validating credentials for it would be an outbound call for no change.
        if (Object.keys(updates).length === 0) {
            return
        }

        const config = request.config ?? aiProvider.config
        // The row being updated is already in hand — resolving its credentials by provider name
        // would read whichever row that name happens to match, which is not necessarily this one.
        const auth = request.auth ?? await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)
        await this.validateProviderCredentials(aiProvider.provider, auth, config)

        if (request.enabledForChat === true) {
            await aiProviderRepo().manager.transaction(async (manager) => {
                await manager.update(AIProviderEntity, { platformId }, { enabledForChat: false })
                await manager.update(AIProviderEntity, providerId, updates)
            })
        }
        else {
            await aiProviderRepo().update(providerId, updates)
        }
    },

    async getChatProvider({ platformId }: { platformId: PlatformId }): Promise<GetProviderConfigResponse | null> {
        const chatProvider = await aiProviderRepo().findOneBy({ platformId, enabledForChat: true })
        if (isNil(chatProvider)) {
            return null
        }
        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(chatProvider.auth)
        return { provider: chatProvider.provider, auth, config: chatProvider.config, platformId }
    },

    async delete(platformId: PlatformId, providerId: string): Promise<void> {
        await aiProviderRepo().delete({
            platformId,
            id: providerId,
        })
    },
    async validateProviderCredentials(provider: AIProviderName, auth: AIProviderAuthConfig, config: AIProviderConfig): Promise<void> {
        const providerStrategy = aiProviders[provider]
        try {
            await providerStrategy.validateConnection(auth, config, log)
        }
        catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            const includeHttpErrorInMessage = provider === AIProviderName.CLOUDFLARE_GATEWAY
            log.error({ err: error }, '[aiProviderService#validateProviderCredentials] Failed to validate provider credentials')
            throw new QadamFlowError({
                code: ErrorCode.INVALID_AI_PROVIDER_CREDENTIALS,
                params: {
                    provider,
                    message: includeHttpErrorInMessage
                        ? `Failed to validate credentials for ${providerStrategy.name}, ${errorMessage}`
                        : `Failed to validate credentials for ${providerStrategy.name}`,
                    httpErrorResponse: errorMessage,
                },
            })
        }
    },
    async getConfigOrThrow({ platformId, provider }: GetOrCreateQadamFlowConfigResponse): Promise<GetProviderConfigResponse> {
        const aiProvider = await findProviderOrThrow({ platformId, provider })

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)

        return { provider: aiProvider.provider, auth, config: aiProvider.config, platformId }
    },
})

async function findProviderOrThrow({ platformId, provider }: GetOrCreateQadamFlowConfigResponse): Promise<AIProviderSchema> {
    const aiProvider = await aiProviderRepo().findOneBy({
        platformId,
        provider,
    })
    if (isNil(aiProvider)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityId: provider,
                entityType: 'AIProvider',
            },
        })
    }
    return aiProvider
}

function isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
        return false
    }
    const driverError: unknown = error.driverError
    return (
        typeof driverError === 'object' &&
        driverError !== null &&
        'code' in driverError &&
        driverError.code === POSTGRES_UNIQUE_VIOLATION
    )
}

const POSTGRES_UNIQUE_VIOLATION = '23505'

type GetOrCreateQadamFlowConfigResponse = {
    platformId: PlatformId
    provider: AIProviderName
}

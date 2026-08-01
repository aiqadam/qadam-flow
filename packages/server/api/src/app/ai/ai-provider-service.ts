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
    parseProviderConfig,
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

    async listModels({ platformId, ref }: ProviderRef): Promise<AIProviderModel[]> {
        const aiProvider = await findProviderOrThrow({ platformId, ref })

        // Keyed on the row, not on the credentials: two configs can share an api key and still
        // point at different endpoints (an Azure resource name, a base url), and a key in a
        // process-wide map is a secret living somewhere it has no reason to be. `updated` moves
        // whenever the config or the credentials are edited, which invalidates the entry.
        const cacheKey = `${aiProvider.id}-${new Date(aiProvider.updated).getTime()}`
        const config = aiProvider.config
        if (modelsCache.has(cacheKey) && !('models' in config)) {
            return modelsCache.get(cacheKey)!
        }

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)
        const data = await aiProviders[aiProvider.provider].listModels(auth, config)

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
            const existing = await aiProviderRepo().findOneBy({ platformId, provider: request.provider })
            throw new QadamFlowError({
                code: ErrorCode.EXISTING_AI_PROVIDER,
                params: {
                    provider: request.provider,
                    // The dialog renders params.message, and what it used to render here was the
                    // raw Postgres message including the index name.
                    message: isNil(existing)
                        ? 'This provider is already configured for this platform'
                        : `This provider is already configured for this platform as "${existing.displayName}"`,
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

        // `UpdateAIProviderRequest.config` is the untagged union, whose tail is several
        // `z.object({})` members — so a config missing a required field for this provider does not
        // fail validation, it parses to `{}` and every field is dropped. Re-checking it against
        // this row's own provider is what stops an edit of one field wiping the rest.
        const requestedConfig = isNil(request.config)
            ? undefined
            : parseProviderConfig({ provider: aiProvider.provider, config: request.config })
        if (!isNil(request.config) && isNil(requestedConfig)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Invalid configuration for a ${aiProvider.provider} provider` },
            })
        }

        const encryptedAuth = !isNil(request.auth) ? await encryptUtils.encryptObject(request.auth) : undefined
        const updates = {
            ...spreadIfDefined('auth', encryptedAuth),
            ...spreadIfDefined('config', requestedConfig),
            ...spreadIfDefined('enabledForChat', request.enabledForChat),
            ...spreadIfDefined('displayName', request.displayName),
        }

        // Every field is optional, so a request can carry nothing this endpoint understands — a
        // misspelled key is stripped by zod and would otherwise be answered 200 having changed
        // nothing. TypeORM rejects an empty update anyway.
        if (Object.keys(updates).length === 0) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'No updatable fields were provided' },
            })
        }

        const config = requestedConfig ?? aiProvider.config
        // The row being updated is already in hand. Resolving its credentials by provider name
        // returns the same row only because the unique index guarantees one row per name — that is
        // latent rather than live today, and it is exactly what #98 removes.
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
        return { id: chatProvider.id, provider: chatProvider.provider, auth, config: chatProvider.config, platformId }
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
    async getConfigOrThrow({ platformId, ref }: ProviderRef): Promise<GetProviderConfigResponse> {
        const aiProvider = await findProviderOrThrow({ platformId, ref })

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)

        return { id: aiProvider.id, provider: aiProvider.provider, auth, config: aiProvider.config, platformId }
    },
})

function isProviderName(ref: string): ref is AIProviderName {
    const names: string[] = Object.values(AIProviderName)
    return names.includes(ref)
}

async function findProviderOrThrow({ platformId, ref }: ProviderRef): Promise<AIProviderSchema> {
    // A name can now match more than one row (custom providers), so the legacy name path needs a
    // stated tiebreak rather than whichever row Postgres happens to return. Oldest wins: that is
    // the row that already existed when every name-keyed caller was written.
    const aiProvider = isProviderName(ref)
        ? await aiProviderRepo().findOne({ where: { platformId, provider: ref }, order: { created: 'ASC' } })
        : await aiProviderRepo().findOneBy({ platformId, id: ref })
    if (isNil(aiProvider)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityId: ref,
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

/**
 * `ref` addresses one provider row: either its id, or an `AIProviderName`. The name form exists
 * permanently, not as a transition — published qadam versions are pinned exactly and build
 * `/v1/ai-providers/${provider}/config` from the enum, so those calls never stop arriving.
 */
type ProviderRef = {
    platformId: PlatformId
    ref: string
}

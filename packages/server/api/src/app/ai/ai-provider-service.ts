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
import { EntityManager, QueryFailedError } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { encryptUtils } from '../helper/encryption'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { AIProviderEntity, AIProviderSchema } from './ai-provider-entity'
import { modelsCache } from './models-cache'
import { aiProviders } from './providers'

const aiProviderRepo = repoFactory<AIProviderSchema>(AIProviderEntity)

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
        const cacheKey = `${aiProvider.id}-${new Date(aiProvider.updated).getTime()}`
        const config = aiProvider.config
        // A config carrying its own `models` list is never read back from the cache, so writing
        // it only ever cost memory — and it was the one path an attacker could grow for free,
        // since CUSTOM's `validateConnection` makes no network call.
        const cacheable = !('models' in config)
        if (cacheable) {
            const cached = modelsCache.get(cacheKey)
            if (!isNil(cached)) {
                return cached
            }
        }

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)
        const data = await aiProviders[provider].listModels(auth, config)

        const models = data.map(model => ({
            id: model.id,
            name: model.name,
            type: model.type,
        }))
        if (cacheable) {
            modelsCache.set({ key: cacheKey, models })
        }

        return models
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
            await aiProviderRepo().manager.transaction(async (manager) => {
                await assertCustomProviderLimitNotExceeded({ manager, platformId, provider: request.provider })
                if (newProvider.enabledForChat) {
                    await manager.update(AIProviderEntity, { platformId }, { enabledForChat: false })
                }
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

// The eight single-instance providers are capped at one row each by the unique index; `custom` is
// the only kind a platform may hold many of, so it is the only one that needs a ceiling of its
// own. It is enforced here rather than in the schema because it is a property of the platform,
// not of the request.
//
// The advisory lock is taken inside the caller's transaction and released when that transaction
// ends, so the count and the insert it guards are atomic together — a plain count-then-insert
// under READ COMMITTED lets two concurrent creates both read "under the cap" and both write.
// It is a Postgres transaction-scoped lock rather than the Redis `distributedLock` used for the
// TEAM-projects cap precisely because it cannot expire before the insert commits.
async function assertCustomProviderLimitNotExceeded({ manager, platformId, provider }: AssertCustomProviderLimitParams): Promise<void> {
    if (provider !== AIProviderName.CUSTOM) {
        return
    }
    const limit = getMaxCustomProvidersPerPlatform()
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai-provider-custom-limit:${platformId}`])
    const current = await manager.countBy(AIProviderEntity, { platformId, provider: AIProviderName.CUSTOM })
    if (current >= limit) {
        throw new QadamFlowError({
            code: ErrorCode.RESOURCE_LIMIT_EXCEEDED,
            params: {
                resource: 'custom_ai_providers',
                limit,
            },
        })
    }
}

// Unlike the TEAM-projects cap, this one must never resolve to "unlimited": it exists so that a
// ceiling is always present, and `system.getNumber` returns null for an unparseable value just as
// it does for an unset one (the startup validator only warns). A missing, malformed or
// non-positive override therefore falls back to the built-in default rather than removing the cap.
function getMaxCustomProvidersPerPlatform(): number {
    const configuredValue = system.getNumber(AppSystemProp.MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM)
    if (isNil(configuredValue) || configuredValue <= 0) {
        return DEFAULT_MAX_CUSTOM_PROVIDERS_PER_PLATFORM
    }
    return configuredValue
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

// Twenty is roughly twice the entire supported vendor list, and the settings page renders one card
// per row — an operator fronting several self-hosted OpenAI-compatible endpoints (Ollama, LM
// Studio, vLLM, a gateway or two) needs a handful. It replaces the ceiling the total unique index
// used to provide incidentally, and it is an operator knob so that the rare deployment that needs
// more is not blocked by a number chosen here.
const DEFAULT_MAX_CUSTOM_PROVIDERS_PER_PLATFORM = 20

type GetOrCreateQadamFlowConfigResponse = {
    platformId: PlatformId
    provider: AIProviderName
}

type AssertCustomProviderLimitParams = {
    manager: EntityManager
    platformId: PlatformId
    provider: AIProviderName
}

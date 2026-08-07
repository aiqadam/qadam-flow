import { cryptoUtils } from '@aiqadam/server-utils'
import { API_KEY_PREFIX, API_KEY_SECRET_LENGTH, apId, ApId, ApiKey, ApiKeyResponseWithValue, CreateApiKeyRequest, ErrorCode, isNil, omit, QadamFlowError, ResponseApiKey, secureApId, SeekPage } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { EntityManager } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { ApiKeyEntity } from './api-key.entity'

const repo = repoFactory(ApiKeyEntity)

export const apiKeyService = {
    async create({ platformId, request }: { platformId: ApId, request: CreateApiKeyRequest }): Promise<ApiKeyResponseWithValue> {
        const value = generateSecret()
        const apiKey: ApiKey = {
            id: apId(),
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
            displayName: request.displayName,
            platformId,
            hashedValue: cryptoUtils.hashSHA256(value),
            truncatedValue: value.slice(-4),
        }

        await repo().manager.transaction(async (manager) => {
            await assertApiKeyLimitNotExceeded({ manager, platformId })
            await repo(manager).insert(apiKey)
        })

        return {
            ...omit(apiKey, ['hashedValue']),
            value,
        }
    },

    async list({ platformId, cursor, limit }: { platformId: ApId, cursor: string | undefined, limit: number | undefined }): Promise<SeekPage<ResponseApiKey>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)
        const paginator = buildPaginator({
            entity: ApiKeyEntity,
            query: {
                limit: limit ?? 10,
                order: 'ASC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        const query = repo().createQueryBuilder(ApiKeyEntity.options.name).where({ platformId })
        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<ResponseApiKey>(data.map((apiKey) => omit(apiKey, ['hashedValue'])), newCursor)
    },

    async delete({ id, platformId }: { id: ApId, platformId: ApId }): Promise<void> {
        await repo().delete({ id, platformId })
    },

    async getByValueOrThrow(value: string): Promise<ApiKey> {
        const apiKey = await repo().findOneBy({ hashedValue: cryptoUtils.hashSHA256(value) })
        if (isNil(apiKey)) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_API_KEY,
                params: {},
            })
        }
        return apiKey
    },
}

function generateSecret(): string {
    return `${API_KEY_PREFIX}${secureApId(API_KEY_SECRET_LENGTH)}`
}

// The advisory lock is taken inside the caller's transaction and released when that transaction
// ends, so the count and the insert it guards are atomic together — a plain count-then-insert
// under READ COMMITTED lets two concurrent creates both read "under the cap" and both write.
// Same pattern as `assertCustomProviderLimitNotExceeded` in ai-provider-service.ts, keyed on
// platformId alone here since the cap is per-platform regardless of key type.
async function assertApiKeyLimitNotExceeded({ manager, platformId }: AssertApiKeyLimitParams): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`api-key-limit:${platformId}`])
    const keyCount = await manager.countBy(ApiKeyEntity, { platformId })
    if (keyCount >= MAX_API_KEYS_PER_PLATFORM) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: {
                message: `A platform can have at most ${MAX_API_KEYS_PER_PLATFORM} API keys`,
            },
        })
    }
}

export const MAX_API_KEYS_PER_PLATFORM = 50

type AssertApiKeyLimitParams = {
    manager: EntityManager
    platformId: ApId
}

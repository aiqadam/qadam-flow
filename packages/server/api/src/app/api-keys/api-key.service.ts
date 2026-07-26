import { cryptoUtils } from '@aiqadam/server-utils'
import { API_KEY_PREFIX, API_KEY_SECRET_LENGTH, apId, ApId, ApiKey, ApiKeyResponseWithValue, CreateApiKeyRequest, ErrorCode, isNil, omit, QadamFlowError, ResponseApiKey, secureApId, SeekPage } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { ApiKeyEntity } from './api-key.entity'

const repo = repoFactory(ApiKeyEntity)

export const apiKeyService = {
    async create({ platformId, request }: { platformId: ApId, request: CreateApiKeyRequest }): Promise<ApiKeyResponseWithValue> {
        const keyCount = await repo().countBy({ platformId })
        if (keyCount >= MAX_API_KEYS_PER_PLATFORM) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `A platform can have at most ${MAX_API_KEYS_PER_PLATFORM} API keys`,
                },
            })
        }

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
        await repo().insert(apiKey)
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

const MAX_API_KEYS_PER_PLATFORM = 50

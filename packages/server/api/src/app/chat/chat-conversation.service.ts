import {
    apId,
    ChatConversation,
    ChatConversationStatus,
    CreateChatConversationRequest,
    ErrorCode,
    isNil,
    PersistedChatMessage,
    QadamFlowError,
    SeekPage,
    spreadIfNotUndefined,
    UpdateChatConversationRequest,
} from '@aiqadam/shared'
import { repoFactory } from '../core/db/repo-factory'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { ChatConversationEntity } from './chat-conversation-entity'

const repo = repoFactory(ChatConversationEntity)

export const chatConversationService = {
    async create({ platformId, userId, request }: CreateParams): Promise<ChatConversation> {
        return repo().save({
            id: apId(),
            platformId,
            userId,
            projectId: null,
            title: request.title ?? null,
            modelName: request.modelName ?? null,
            status: ChatConversationStatus.IDLE,
            messages: [],
            uiMessages: null,
            summary: null,
            summarizedUpToIndex: null,
        })
    },

    async list({ platformId, userId, cursor, limit }: ListParams): Promise<SeekPage<ChatConversation>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor ?? null)
        const paginator = buildPaginator({
            entity: ChatConversationEntity,
            query: {
                limit,
                order: 'DESC',
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })
        // Scoped by userId as well as platformId: a conversation is private to the person who
        // opened it, and it carries their prompts and the outputs of tools run as them.
        const query = repo().createQueryBuilder(ChatConversationEntity.options.name).where({ platformId, userId })
        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<ChatConversation>(data, newCursor)
    },

    async getOneOrThrow({ id, platformId, userId }: GetParams): Promise<ChatConversation> {
        const conversation = await repo().findOneBy({ id, platformId, userId })
        if (isNil(conversation)) {
            // Deliberately the same error whether the row is absent or belongs to someone else,
            // so the endpoint cannot be used to probe for other users' conversation ids.
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: id, entityType: 'ChatConversation' },
            })
        }
        return conversation
    },

    async getMessages({ id, platformId, userId }: GetParams): Promise<PersistedChatMessage[]> {
        const conversation = await this.getOneOrThrow({ id, platformId, userId })
        return conversation.uiMessages ?? []
    },

    async update({ id, platformId, userId, request }: UpdateParams): Promise<ChatConversation> {
        await this.getOneOrThrow({ id, platformId, userId })
        await repo().update({ id, platformId, userId }, {
            ...spreadIfNotUndefined('title', request.title),
            ...spreadIfNotUndefined('modelName', request.modelName),
        })
        return this.getOneOrThrow({ id, platformId, userId })
    },

    async delete({ id, platformId, userId }: GetParams): Promise<void> {
        await this.getOneOrThrow({ id, platformId, userId })
        await repo().delete({ id, platformId, userId })
    },
}

type CreateParams = {
    platformId: string
    userId: string
    request: CreateChatConversationRequest
}

type ListParams = {
    platformId: string
    userId: string
    cursor: string | undefined
    limit: number
}

type GetParams = {
    id: string
    platformId: string
    userId: string
}

type UpdateParams = GetParams & {
    request: UpdateChatConversationRequest
}

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
        //
        // The transcript columns are deliberately excluded. A single row can hold tens of
        // megabytes — a message may carry ten 10 MB attachments, base64-encoded into `messages` —
        // so serialising 100 of them would let any authenticated user pull gigabytes through the
        // event loop in one request and stall the process for every tenant on the instance. The
        // client never reads them from here anyway; it fetches them per conversation from
        // `GET /conversations/:id/messages`.
        const query = repo()
            .createQueryBuilder(ChatConversationEntity.options.name)
            .select(LIST_COLUMNS.map((column) => `${ChatConversationEntity.options.name}.${column}`))
            .where({ platformId, userId })
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

    // `save` rather than `update` throughout the run lifecycle: TypeORM's
    // `QueryDeepPartialEntity` cannot express a json column holding a discriminated union, so an
    // `update` of `messages`/`uiMessages` does not type-check at all.
    // Admitting a run is a read-modify-write on `uiMessages` guarded by a status read, so it runs
    // inside a transaction with the row locked `FOR UPDATE`. Without the lock two simultaneous
    // POSTs both read IDLE, both pass the guard and both append — losing one turn and billing the
    // operator twice — and the guard would look correct while never having held. The repo's
    // multi-server rule calls for exactly this on concurrent operations.
    async startRun({ id, platformId, userId, projectId, userMessage }: StartRunParams): Promise<void> {
        await repo().manager.transaction(async (entityManager) => {
            const conversation = await entityManager.findOne(ChatConversationEntity, {
                where: { id, platformId, userId },
                lock: { mode: 'pessimistic_write' },
            })
            if (isNil(conversation)) {
                throw new QadamFlowError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: { entityId: id, entityType: 'ChatConversation' },
                })
            }
            if (conversation.status === ChatConversationStatus.STREAMING && !isAbandoned(conversation)) {
                // Refusing the second is better than corrupting the history; the client already
                // disables sending while a run is in flight, so this catches a second tab or a
                // retry rather than normal use.
                throw new QadamFlowError({
                    code: ErrorCode.VALIDATION,
                    params: { message: 'This conversation is already generating a reply. Wait for it to finish or cancel it first.' },
                })
            }
            await entityManager.save(ChatConversationEntity, {
                ...conversation,
                // Pinned on the first run so every later turn — and the connection picker —
                // resolves the same project, instead of drifting with the user's project list.
                projectId,
                status: ChatConversationStatus.STREAMING,
                uiMessages: [...(conversation.uiMessages ?? []), userMessage],
            })
        })
    },

    async finishRun({ id, platformId, userId, messages, assistantMessage }: FinishRunParams): Promise<void> {
        const conversation = await this.getOneOrThrow({ id, platformId, userId })
        await repo().save({
            ...conversation,
            status: ChatConversationStatus.IDLE,
            messages,
            // Nullable because a run cancelled before the first token has no assistant turn to
            // record, and an empty bubble reads worse than none — but the conversation still has
            // to leave STREAMING or the client's stale-check spins forever.
            uiMessages: isNil(assistantMessage)
                ? conversation.uiMessages
                : [...(conversation.uiMessages ?? []), assistantMessage],
        })
    },

    async failRun({ id, platformId, userId }: GetParams): Promise<void> {
        const conversation = await this.getOneOrThrow({ id, platformId, userId })
        await repo().save({ ...conversation, status: ChatConversationStatus.ERROR })
    },

    // Called on every step boundary so `updated` keeps moving while a run is genuinely alive. That
    // is what lets `isAbandoned` tell "still working" from "the process that owned this died", and
    // it is why the staleness window can be short enough to be useful.
    async touchRun({ id, platformId, userId }: GetParams): Promise<void> {
        await repo().update({ id, platformId, userId, status: ChatConversationStatus.STREAMING }, { updated: new Date().toISOString() })
    },

    // Settling the row is the caller's job as well as the loop's. A cancel that reaches an API
    // instance which is not the one running the loop — or a conversation whose owning process is
    // simply gone — must still leave STREAMING, or the client polls forever and every later
    // message 409s with nothing the user can do about it.
    async cancelRun({ id, platformId, userId }: GetParams): Promise<void> {
        await repo().update({ id, platformId, userId, status: ChatConversationStatus.STREAMING }, { status: ChatConversationStatus.IDLE })
    },
}

// A live run touches the row at every step, and the transport gives up on a silent provider after
// 120s, so a STREAMING row untouched for this long belongs to a process that is no longer running
// — an API restart mid-run, which is routine on a self-hosted upgrade. Without this the
// conversation is wedged permanently: nothing settles the row, every message 409s, and the client
// spins on a status that will never change.
const ABANDONED_RUN_AFTER_MS = 5 * 60 * 1000

function isAbandoned(conversation: ChatConversation): boolean {
    return Date.now() - new Date(conversation.updated).getTime() > ABANDONED_RUN_AFTER_MS
}

// Everything the conversation list needs to render a row, and nothing that grows with the
// conversation. `paginationHelper` needs `created`/`id` for its cursor.
const LIST_COLUMNS = ['id', 'created', 'updated', 'platformId', 'projectId', 'userId', 'title', 'modelName', 'status', 'summary', 'summarizedUpToIndex']

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

type StartRunParams = GetParams & {
    projectId: string
    userMessage: PersistedChatMessage
}

type FinishRunParams = GetParams & {
    messages: ChatConversation['messages']
    assistantMessage: PersistedChatMessage | null
}

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
import { FastifyBaseLogger } from 'fastify'
import { MoreThan } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { buildPaginator } from '../helper/pagination/build-paginator'
import { paginationHelper } from '../helper/pagination/pagination-utils'
import { ChatConversationEntity, ChatConversationSchema } from './chat-conversation-entity'

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
    // Admission is serialised per user, not just per conversation. The row lock below covers only
    // the conversation being admitted; the concurrent-run cap counts the user's *other*
    // conversations, which that lock says nothing about — two POSTs to two different conversations
    // would each lock their own row, each count the same N, and each be let through. This lock is
    // what makes the cap mean what it says.
    async startRun({ id, platformId, userId, projectId, runId, userMessage, log }: StartRunParams): Promise<TakenOverRun> {
        return distributedLock(log).runExclusive({
            key: `chat-run-admission:${userId}`,
            timeoutInSeconds: 10,
            fn: () => admitRun({ id, platformId, userId, projectId, runId, userMessage }),
        })
    },

    // Every write below is conditional on `activeRunId`. A run that was cancelled or displaced
    // must not settle the row afterwards: it would report IDLE while a newer run is still
    // streaming, and the next message would then be admitted alongside it.
    async finishRun({ id, platformId, userId, runId, messages, assistantMessage }: FinishRunParams): Promise<void> {
        await repo().manager.transaction(async (entityManager) => {
            const conversation = await entityManager.findOne(ChatConversationEntity, {
                where: { id, platformId, userId, activeRunId: runId },
                lock: { mode: 'pessimistic_write' },
            })
            if (isNil(conversation)) {
                return
            }
            await entityManager.save(ChatConversationEntity, {
                ...conversation,
                status: ChatConversationStatus.IDLE,
                activeRunId: null,
                runHeartbeat: null,
                messages,
                // Nullable because a run cancelled before the first token has no assistant turn to
                // record, and an empty bubble reads worse than none — but the conversation still
                // has to leave STREAMING or the client's stale-check spins forever.
                uiMessages: isNil(assistantMessage)
                    ? conversation.uiMessages
                    : [...(conversation.uiMessages ?? []), assistantMessage],
            })
        })
    },

    async failRun({ id, platformId, userId, runId }: RunScopedParams): Promise<void> {
        await repo().update(
            { id, platformId, userId, activeRunId: runId },
            { status: ChatConversationStatus.ERROR, activeRunId: null, runHeartbeat: null },
        )
    },

    // Proof of life, written at every step boundary. `runHeartbeat` rather than `updated` because
    // `updated` is an `@UpdateDateColumn` that an unrelated rename would bump, silently extending
    // a dead run's lease.
    async touchRun({ id, platformId, userId, runId }: RunScopedParams): Promise<void> {
        await repo().update({ id, platformId, userId, activeRunId: runId }, { runHeartbeat: new Date().toISOString() })
    },

    // Settling the row is the caller's job as well as the loop's: a cancel may reach an instance
    // that is not running the loop, or one whose owner has since restarted. Returns the run it
    // stopped so the caller can abort that loop locally if it happens to be here.
    async cancelRun({ id, platformId, userId }: GetParams): Promise<TakenOverRun> {
        return repo().manager.transaction(async (entityManager) => {
            const conversation = await entityManager.findOne(ChatConversationEntity, {
                where: { id, platformId, userId, status: ChatConversationStatus.STREAMING },
                lock: { mode: 'pessimistic_write' },
            })
            if (isNil(conversation)) {
                return { displacedRunId: null }
            }
            // Status only. `activeRunId` stays, so the loop being cancelled can still settle its
            // own row and keep whatever it managed to stream — `finishRun` matches on that id.
            // Clearing it here would silently discard the partial reply. A leftover id on an IDLE
            // row is harmless: admission looks at the status, and `startRun` overwrites it.
            await entityManager.update(ChatConversationEntity, { id }, { status: ChatConversationStatus.IDLE })
            return { displacedRunId: conversation.activeRunId }
        })
    },
}


async function admitRun({ id, platformId, userId, projectId, runId, userMessage }: AdmitRunParams): Promise<TakenOverRun> {
    return repo().manager.transaction(async (entityManager) => {
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
        // Per-conversation limits bound one run; nothing bounded how many a user starts. A
        // single account could open conversations without limit and fire a message into each,
        // every one of them worth up to MAX_AGENT_STEPS paid round-trips on the operator's
        // provider bill plus a detached loop holding a stream. Counted inside the same
        // transaction as the admission so two simultaneous starts cannot both read "under".
        // Stale rows are excluded, or a crashed run would hold a slot for five minutes and a
        // few restarts would lock the user out of their own chat entirely.
        const running = await entityManager.count(ChatConversationEntity, {
            where: {
                platformId,
                userId,
                status: ChatConversationStatus.STREAMING,
                runHeartbeat: MoreThan(new Date(Date.now() - ABANDONED_RUN_AFTER_MS).toISOString()),
            },
        })
        if (running >= MAX_CONCURRENT_RUNS_PER_USER) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'You already have several replies generating. Wait for one to finish before starting another.' },
            })
        }

        await entityManager.save(ChatConversationEntity, {
            ...conversation,
            // Pinned on the first run so every later turn — and the connection picker —
            // resolves the same project, instead of drifting with the user's project list.
            projectId,
            status: ChatConversationStatus.STREAMING,
            activeRunId: runId,
            runHeartbeat: new Date().toISOString(),
            uiMessages: [...(conversation.uiMessages ?? []), userMessage],
        })

        // Handed back so the caller can abort the loop it just displaced, if that loop happens
        // to live in this process. Taking the row without stopping the incumbent is how one
        // conversation ends up with two live loops writing it.
        return { displacedRunId: conversation.activeRunId }
    })
}

// A live run touches the row at every step, and the transport gives up on a silent provider after
// 120s, so a STREAMING row untouched for this long belongs to a process that is no longer running
// — an API restart mid-run, which is routine on a self-hosted upgrade. Without this the
// conversation is wedged permanently: nothing settles the row, every message 409s, and the client
// spins on a status that will never change.
const ABANDONED_RUN_AFTER_MS = 5 * 60 * 1000

// Generous for a person — nobody reads three streaming replies at once — and low enough that one
// account cannot turn the operator's provider bill into a denial-of-service. Abandoned rows do not
// hold a slot: they are excluded by the takeover above the moment they go stale.
const MAX_CONCURRENT_RUNS_PER_USER = 3

function isAbandoned(conversation: ChatConversationSchema): boolean {
    // No heartbeat at all means the row predates any heartbeat write, which can only be a run that
    // never got one — treat it as abandoned rather than letting it hold the conversation forever.
    return isNil(conversation.runHeartbeat)
        || Date.now() - new Date(conversation.runHeartbeat).getTime() > ABANDONED_RUN_AFTER_MS
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

type RunScopedParams = GetParams & {
    runId: string
}

type AdmitRunParams = RunScopedParams & {
    projectId: string
    userMessage: PersistedChatMessage
}

type StartRunParams = AdmitRunParams & {
    log: FastifyBaseLogger
}

export type TakenOverRun = {
    displacedRunId: string | null
}

type FinishRunParams = RunScopedParams & {
    messages: ChatConversation['messages']
    assistantMessage: PersistedChatMessage | null
}

import { apId, ChatConversationStatus, DefaultProjectRole, PersistedChatPartType, PersistedChatRole } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { chatConversationService } from '../../../../src/app/chat/chat-conversation.service'
import { db } from '../../../helpers/db'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

async function createConversation(context: TestContext, body: Record<string, unknown> = {}): Promise<Record<string, string>> {
    const response = await context.post('/v1/chat/conversations', body)
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response!.json()
}

describe('Chat conversations API', () => {
    describe('POST /v1/chat/conversations', () => {
        it('creates an idle conversation owned by the caller', async () => {
            const conversation = await createConversation(ctx, { title: 'Automate my inbox' })

            expect(conversation).toMatchObject({
                title: 'Automate my inbox',
                status: ChatConversationStatus.IDLE,
                platformId: ctx.platform.id,
                userId: ctx.user.id,
            })
            // Null rather than the caller's project: the model picks a project mid-conversation,
            // so the row must be creatable without one.
            expect(conversation['projectId']).toBeNull()
        })

        it('persists the row against the caller, not just the response', async () => {
            const conversation = await createConversation(ctx)

            const saved = await db.findOneBy('chat_conversation', { id: conversation['id'] })
            expect(saved).toMatchObject({
                platformId: ctx.platform.id,
                userId: ctx.user.id,
            })
        })
    })

    describe('GET /v1/chat/conversations', () => {
        it('lists only the caller own conversations, not a platform sibling ones', async () => {
            // Same platform on purpose — two separate createTestContext calls would give two
            // different platforms, and the test would then pass even with platform-only scoping.
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const mine = await createConversation(ctx, { title: 'mine' })
            const theirs = await createConversation(sibling, { title: 'theirs' })

            const response = await ctx.get('/v1/chat/conversations')

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const ids = response!.json().data.map((row: Record<string, string>) => row.id)
            expect(ids).toContain(mine['id'])
            expect(ids).not.toContain(theirs['id'])
        })

        // A conversation row can hold tens of megabytes — a message may carry ten 10 MB
        // attachments, base64-encoded. Serialising those for a page of 100 would let any
        // authenticated user pull gigabytes through the event loop in one request and stall the
        // instance for every tenant. The client reads transcripts per conversation instead.
        it('does not return the transcript blobs, only what a list row needs', async () => {
            const conversation = await createConversation(ctx, { title: 'has a transcript' })
            await db.update('chat_conversation', conversation['id'], {
                uiMessages: [{ role: 'user', parts: [{ type: 'text', text: 'a very large transcript' }] }],
                messages: [{ role: 'user', content: 'a very large transcript' }],
            })

            const response = await ctx.get('/v1/chat/conversations')

            const row = response!.json().data.find((candidate: Record<string, unknown>) => candidate.id === conversation['id'])
            expect(row.title).toBe('has a transcript')
            expect(row.messages).toBeUndefined()
            expect(row.uiMessages).toBeUndefined()
        })

        it('honours the page limit', async () => {
            await createConversation(ctx)
            await createConversation(ctx)
            await createConversation(ctx)

            const response = await ctx.get('/v1/chat/conversations', { limit: 2 })

            expect(response!.json().data).toHaveLength(2)
        })
    })

    describe('GET /v1/chat/conversations/:id', () => {
        it('returns the caller own conversation', async () => {
            const conversation = await createConversation(ctx, { title: 'readable' })

            const response = await ctx.get(`/v1/chat/conversations/${conversation['id']}`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json().title).toBe('readable')
        })

        it('hides a platform sibling conversation behind the same 404 as a missing one', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const theirs = await createConversation(sibling, { title: 'theirs' })

            const found = await ctx.get(`/v1/chat/conversations/${theirs['id']}`)
            // A well-formed id that simply does not exist — a malformed one would be rejected by
            // schema validation with a 400 and would not compare like for like.
            const missing = await ctx.get(`/v1/chat/conversations/${apId()}`)

            expect(found?.statusCode).toBe(StatusCodes.NOT_FOUND)
            expect(found?.statusCode).toBe(missing?.statusCode)
        })
    })

    describe('GET /v1/chat/conversations/:id/messages', () => {
        it('returns an empty list for a fresh conversation', async () => {
            const conversation = await createConversation(ctx)

            const response = await ctx.get(`/v1/chat/conversations/${conversation['id']}/messages`)

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json()).toEqual({ data: [] })
        })

        it('refuses to read a platform sibling messages', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const theirs = await createConversation(sibling)

            const response = await ctx.get(`/v1/chat/conversations/${theirs['id']}/messages`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('POST /v1/chat/conversations/:id (update)', () => {
        it('updates the title and leaves untouched fields alone', async () => {
            const conversation = await createConversation(ctx, { title: 'before', modelName: 'gpt-4o' })

            const response = await ctx.post(`/v1/chat/conversations/${conversation['id']}`, { title: 'after' })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response!.json()).toMatchObject({ title: 'after', modelName: 'gpt-4o' })
        })

        it('refuses to update a platform sibling conversation', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const theirs = await createConversation(sibling, { title: 'theirs' })

            const response = await ctx.post(`/v1/chat/conversations/${theirs['id']}`, { title: 'hijacked' })

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            const saved = await db.findOneBy('chat_conversation', { id: theirs['id'] })
            expect(saved).toMatchObject({ title: 'theirs' })
        })
    })

    // These sit at the service, not the HTTP surface, on purpose. The interleaving they guard
    // against — a displaced run settling the row after a newer run has taken it — cannot be forced
    // through the API, because cancel aborts the old loop before the new message is admitted. An
    // end-to-end test of it would pass whether or not the guard exists, which is worse than none.
    describe('run ownership', () => {
        async function streamingConversation(activeRunId: string): Promise<string> {
            const conversation = await createConversation(ctx)
            await db.update('chat_conversation', conversation['id'], {
                status: ChatConversationStatus.STREAMING,
                activeRunId,
                runHeartbeat: new Date().toISOString(),
            })
            return conversation['id']
        }

        it('ignores a finish from a run that no longer owns the conversation', async () => {
            const id = await streamingConversation('run-that-took-over')

            await chatConversationService.finishRun({
                id,
                platformId: ctx.platform.id,
                userId: ctx.user.id,
                runId: 'run-that-was-displaced',
                messages: [],
                assistantMessage: { role: PersistedChatRole.ASSISTANT, parts: [{ type: PersistedChatPartType.TEXT, text: 'stale reply' }] },
            })

            const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id })
            // Still streaming, still owned by the live run, and the stale reply is not recorded.
            expect(row?.status).toBe(ChatConversationStatus.STREAMING)
            expect(row?.activeRunId).toBe('run-that-took-over')
            expect(row?.uiMessages).toBeNull()
        })

        it('ignores a failure from a run that no longer owns the conversation', async () => {
            const id = await streamingConversation('run-that-took-over')

            await chatConversationService.failRun({
                id,
                platformId: ctx.platform.id,
                userId: ctx.user.id,
                runId: 'run-that-was-displaced',
            })

            const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id })
            expect(row?.status).toBe(ChatConversationStatus.STREAMING)
        })

        it('lets the owning run settle the conversation', async () => {
            const id = await streamingConversation('the-live-run')

            await chatConversationService.finishRun({
                id,
                platformId: ctx.platform.id,
                userId: ctx.user.id,
                runId: 'the-live-run',
                messages: [],
                assistantMessage: { role: PersistedChatRole.ASSISTANT, parts: [{ type: PersistedChatPartType.TEXT, text: 'real reply' }] },
            })

            const row = await db.findOneBy<Record<string, unknown>>('chat_conversation', { id })
            expect(row?.status).toBe(ChatConversationStatus.IDLE)
            expect(row?.activeRunId).toBeNull()
            expect((row?.uiMessages as any[])[0].parts[0].text).toBe('real reply')
        })
    })

    describe('DELETE /v1/chat/conversations/:id', () => {
        it('deletes the caller own conversation', async () => {
            const conversation = await createConversation(ctx)

            const response = await ctx.delete(`/v1/chat/conversations/${conversation['id']}`)

            expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
            expect(await db.findOneBy('chat_conversation', { id: conversation['id'] })).toBeNull()
        })

        it('refuses to delete a platform sibling conversation', async () => {
            const sibling = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.EDITOR })
            const theirs = await createConversation(sibling)

            const response = await ctx.delete(`/v1/chat/conversations/${theirs['id']}`)

            expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
            expect(await db.findOneBy('chat_conversation', { id: theirs['id'] })).not.toBeNull()
        })
    })
})

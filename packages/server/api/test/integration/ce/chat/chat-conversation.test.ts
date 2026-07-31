import { apId, ChatConversationStatus, DefaultProjectRole } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
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

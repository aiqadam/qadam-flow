import {
    ApId,
    CreateChatConversationRequest,
    PrincipalType,
    UpdateChatConversationRequest,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { chatConversationService } from './chat-conversation.service'

export const chatController: FastifyPluginAsyncZod = async (app) => {
    app.post('/conversations', CreateConversationRequest, async (request) => {
        return chatConversationService.create({
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            request: request.body,
        })
    })

    app.get('/conversations', ListConversationsRequest, async (request) => {
        return chatConversationService.list({
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            cursor: request.query.cursor,
            limit: request.query.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE,
        })
    })

    app.get('/conversations/:id', ConversationByIdRequest, async (request) => {
        return chatConversationService.getOneOrThrow({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
    })

    app.get('/conversations/:id/messages', ConversationByIdRequest, async (request) => {
        const data = await chatConversationService.getMessages({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
        return { data }
    })

    // POST rather than PATCH for an update, per the repo-wide HTTP convention; the web client
    // already calls it this way (`packages/web/src/features/chat/lib/chat-api.ts`).
    app.post('/conversations/:id', UpdateConversationRequest, async (request) => {
        return chatConversationService.update({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            request: request.body,
        })
    })

    app.delete('/conversations/:id', ConversationByIdRequest, async (request, reply) => {
        await chatConversationService.delete({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
        return reply.status(204).send()
    })
}

// Platform-scoped rather than project-scoped: a conversation starts before any project is chosen,
// so there is no projectId to authorise against at this layer. Ownership is enforced in the
// service, which filters every query by the principal's own userId.
const chatSecurity = {
    security: securityAccess.publicPlatform([PrincipalType.USER]),
}

const DEFAULT_CONVERSATION_PAGE_SIZE = 20
const MAX_CONVERSATION_PAGE_SIZE = 100

const ConversationIdParams = z.object({
    id: ApId,
})

const CreateConversationRequest = {
    config: chatSecurity,
    schema: {
        body: CreateChatConversationRequest,
    },
}

const ListConversationsRequest = {
    config: chatSecurity,
    schema: {
        querystring: z.object({
            limit: z.coerce.number().int().min(1).max(MAX_CONVERSATION_PAGE_SIZE).optional(),
            cursor: z.string().optional(),
        }),
    },
}

const ConversationByIdRequest = {
    config: chatSecurity,
    schema: {
        params: ConversationIdParams,
    },
}

const UpdateConversationRequest = {
    config: chatSecurity,
    schema: {
        params: ConversationIdParams,
        body: UpdateChatConversationRequest,
    },
}

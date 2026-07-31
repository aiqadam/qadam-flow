import {
    ApId,
    CreateChatConversationRequest,
    ErrorCode,
    PrincipalType,
    QadamFlowError,
    SendChatMessageRequest,
    UpdateChatConversationRequest,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { chatAgentService } from './chat-agent.service'
import { chatConnections } from './chat-connections'
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

    // Answers as soon as the run is admitted; the model round-trips continue in the background and
    // reach the browser over the CHAT_MESSAGE_CHUNK socket event. `chatAgentService.start` does
    // every failure-with-a-cause check before it forks, so a 4xx here still means something real.
    app.post('/conversations/:id/messages', SendMessageRequest, async (request) => {
        return chatAgentService(request.log).start({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            request: request.body,
        })
    })

    app.post('/conversations/:id/cancel', ConversationByIdRequest, async (request, reply) => {
        // Ownership is proven before the abort, so a cancel cannot be used to stop someone
        // else's run by guessing a conversation id.
        await chatConversationService.getOneOrThrow({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
        chatAgentService(request.log).cancel({ id: request.params.id })
        return reply.status(204).send()
    })

    app.get('/conversations/:id/connections', ListConversationConnectionsRequest, async (request) => {
        return chatConnections.list({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            qadamName: request.query.qadamName,
            log: request.log,
        })
    })

    // Tool-approval gates are not implemented in this layer. Returning null is the honest answer
    // and the shape the client already handles — a fabricated gate would make the UI wait for an
    // approval nothing will ever consume.
    app.get('/conversations/:id/pending-gate', ConversationByIdRequest, async (request) => {
        await chatConversationService.getOneOrThrow({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
        return null
    })

    // Same reason, from the other side: with no gates issued there is no gate to approve, so this
    // 404s rather than reporting a success that approved nothing.
    app.post('/tool-approvals/:gateId', ApproveToolCallRequest, async (request) => {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: request.params.gateId, entityType: 'ChatToolApprovalGate' },
        })
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

const SendMessageRequest = {
    config: chatSecurity,
    schema: {
        params: ConversationIdParams,
        body: SendChatMessageRequest,
    },
}

const ListConversationConnectionsRequest = {
    config: chatSecurity,
    schema: {
        params: ConversationIdParams,
        querystring: z.object({
            qadamName: z.string().min(1),
        }),
    },
}

const ApproveToolCallRequest = {
    config: chatSecurity,
    schema: {
        params: z.object({
            gateId: ApId,
        }),
    },
}

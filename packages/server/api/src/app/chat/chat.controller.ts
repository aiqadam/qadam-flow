import {
    AnswerChatToolApprovalRequest,
    ApId,
    CreateChatConversationRequest,
    PrincipalType,
    SendChatMessageRequest,
    UpdateChatConversationRequest,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { chatAgentService } from './chat-agent.service'
import { chatApprovals } from './chat-approvals'
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
        // Settles the row and, if the displaced run happens to be looping in this process,
        // aborts it. A cancel may land on an instance that never owned the run.
        await chatAgentService(request.log).cancel({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
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

    // The gate lives in this conversation's transcript, so reading it is the same authorisation as
    // reading the conversation. `null` when nothing is waiting, which is the shape the client has
    // always handled.
    app.get('/conversations/:id/pending-gate', ConversationByIdRequest, async (request) => {
        const conversation = await chatConversationService.getOneOrThrow({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
        })
        return chatApprovals.findPending(conversation.uiMessages)
    })

    // Nested under the conversation on purpose, and this is the endpoint's main security property.
    // The caller must name a conversation, `getOneOrThrow` filters it by `{ id, platformId, userId }`
    // and 404s someone else's row, and only then is the gate id resolved *inside* that row. A
    // flat `/tool-approvals/:gateId` would have to search every conversation for the id — which
    // makes an id that travels through a socket payload and a rendered card into the whole
    // authorisation, and turns any runtime owner check into a line someone can delete without
    // failing a test. Here the binding is the route.
    app.post('/conversations/:id/tool-approvals/:gateId', AnswerToolApprovalRequest, async (request) => {
        return chatAgentService(request.log).approve({
            id: request.params.id,
            platformId: request.principal.platform.id,
            userId: request.principal.id,
            approvalId: request.params.gateId,
            request: request.body,
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

// Generous next to the 30 characters the SDK actually produces, and still bounded — the value is
// compared against persisted ids, so there is no reason to accept a megabyte of path.
const MAX_GATE_ID_LENGTH = 128

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

// The body used to be unvalidated while the client posted `{ approved, payload }` — an arbitrary
// unvalidated object accepted by the one endpoint whose job is authorisation. `payload` is gone
// rather than schematised: nothing on the server read it, and the gated call's arguments must come
// from the persisted request part, never from whoever answers the gate.
const AnswerToolApprovalRequest = {
    config: chatSecurity,
    schema: {
        params: z.object({
            id: ApId,
            // Not `ApId`: the approval id is minted by the AI SDK, not by `apId()`. `streamText`
            // uses `createIdGenerator({ prefix: 'aitxt', size: 24 })`, so a real gate id looks like
            // `aitxt-<24 chars>` — 30 characters with a hyphen, which `ApId`'s
            // `^[0-9a-zA-Z]{21}$` rejects outright. Validating it as an `ApId` would have 400'd
            // every genuine approval while passing every hand-typed guess.
            gateId: z.string().min(1).max(MAX_GATE_ID_LENGTH),
        }),
        body: AnswerChatToolApprovalRequest,
    },
}

import { readFile } from 'node:fs/promises'
import { chatAiUtils, ContentPartLike } from '@aiqadam/server-utils'
import {
    apId,
    ChatAgentEvent,
    ChatAgentEventType,
    ChatConversation,
    ErrorCode,
    isNil,
    PersistedChatPartType,
    PersistedChatRole,
    ProjectScopedMcpServer,
    ProjectType,
    QadamFlowError,
    SendChatMessageRequest,
    spreadIfDefined,
    tryCatch,
    WebsocketClientEvent,
} from '@aiqadam/shared'
import { ModelMessage, stepCountIs, StepResult, streamText, TextPart, ToolSet, UserContent } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { websocketService } from '../core/websockets.service'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { mcpServerService } from '../mcp/mcp-service'
import { chatConversationService } from './chat-conversation.service'
import { chatModel, ResolvedChatModel } from './chat-model'
import { chatProjects } from './chat-projects'
import { chatTools } from './chat-tools'
import { chatTranscript } from './chat-transcript'

export const chatAgentService = (log: FastifyBaseLogger) => ({
    // Everything that can fail with a cause the caller deserves to read — no provider, no model,
    // no project, not your conversation — happens here, before the handler answers. Only the
    // model round-trips are deferred to the background loop, where the socket is the only
    // channel left to report on.
    async start({ id, platformId, userId, request }: StartParams): Promise<StartChatRunResponse> {
        const conversation = await chatConversationService.getOneOrThrow({ id, platformId, userId })
        const projectId = await resolveProjectId({ conversation, log })
        const resolvedModel = await chatModel.resolve({ platformId, modelName: conversation.modelName, log })

        const mcp = await mcpServerService(log).getByProjectId(projectId)
        const projectScopedMcp: ProjectScopedMcpServer = { ...mcp, projectId }
        const tools = await chatTools.build({ mcp: projectScopedMcp, userId, log })
        const systemPrompt = await buildSystemPrompt({ projectId, platformId, userId, log })

        const runId = request.runId ?? apId()
        const messages = [
            ...chatTranscript.toModelMessages(conversation.uiMessages ?? []),
            buildUserMessage(request),
        ]

        const { displacedRunId } = await chatConversationService.startRun({
            id,
            platformId,
            userId,
            projectId,
            runId,
            log,
            userMessage: { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: request.content }] },
        })

        // A takeover only rewrites the row. If the run it displaced is still looping in this
        // process, it has to be stopped too, or two loops stream the same conversation.
        abortRun(displacedRunId)

        rejectedPromiseHandler(runAgentLoop({
            id,
            platformId,
            userId,
            runId,
            resolvedModel,
            systemPrompt,
            messages,
            tools,
            log,
        }), log)

        return { conversationId: id, runId }
    },

    // Process-local by design: the abort controller cannot be serialised, and there is no
    // cross-instance abort channel in this scope. A cancel that lands on an instance which is not
    // running the loop leaves the run going; the client stops rendering it either way, and the
    // step cap bounds what it can still spend.
    async cancel({ id, platformId, userId }: GetRunParams): Promise<void> {
        const { displacedRunId } = await chatConversationService.cancelRun({ id, platformId, userId })
        abortRun(displacedRunId)
    },
})

// Keyed by run id, not conversation id. Keyed by conversation, a finishing run deleted whatever
// controller was current — so cancel-then-send left the second run live with nothing able to stop
// it, while the row read IDLE and admitted yet another.
const activeRuns = new Map<string, AbortController>()

function abortRun(runId: string | null): void {
    if (isNil(runId)) {
        return
    }
    activeRuns.get(runId)?.abort()
}

// Every step is one paid round-trip to the provider. `streamText` keeps looping while the model
// keeps calling tools, so with no cap a single message can bill the operator without bound — an
// unbounded agent loop against a metered provider is a cost denial-of-service on whoever runs the
// instance. 25 comfortably covers a full research → build → validate → test sequence.
const MAX_AGENT_STEPS = 25

// Read from disk per run using the same relative-to-cwd form the email templates use
// (`helper/mail/email-sender/smtp-email-sender.ts`). That form holds in all three environments:
// `serve` cd's to the repo root, `vitest.config.ts` chdir's to the repo root, and the image sets
// WORKDIR /usr/src/app and does `COPY packages ./packages`, which brings `src/assets` along —
// the compiled `dist/` never contains assets, so a dist-relative path would break the image.
const SYSTEM_PROMPT_PATH = 'packages/server/api/src/assets/prompts/chat-system-prompt.md'

async function runAgentLoop({ id, platformId, userId, runId, resolvedModel, systemPrompt, messages, tools, log }: RunLoopParams): Promise<void> {
    const abortController = new AbortController()
    activeRuns.set(runId, abortController)
    const streamedText: string[] = []

    const { error } = await tryCatch(async () => {
        const result = streamText({
            model: resolvedModel.model,
            system: chatAiUtils.buildSystemPromptWithCaching({ systemPrompt, provider: resolvedModel.provider }),
            messages,
            tools,
            stopWhen: stepCountIs(MAX_AGENT_STEPS),
            abortSignal: abortController.signal,
            // Proof of life for `isAbandoned`. Without it a long run looks identical to one whose
            // process died, and the staleness window would have to be longer than the longest
            // possible run to be safe — which would make it useless.
            onStepFinish: () => {
                rejectedPromiseHandler(chatConversationService.touchRun({ id, platformId, userId, runId }), log)
            },
        })

        for await (const chunk of result.toUIMessageStream()) {
            // Accumulated as it goes rather than read off `result` at the end, because on an abort
            // `result.steps` rejects along with the stream — this is the only copy of the partial
            // reply that survives a cancel.
            collectStreamedText({ chunk, into: streamedText })
            emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.CHUNK, data: chunk } })
        }

        const steps = await result.steps
        const response = await result.response
        await chatConversationService.finishRun({
            id,
            platformId,
            userId,
            runId,
            messages: [...messages, ...response.messages],
            assistantMessage: {
                role: PersistedChatRole.ASSISTANT,
                parts: chatAiUtils.buildStepParts({ content: toContentParts(steps) }),
            },
        })
        emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.FINISHED, data: { conversationId: id } } })
    })

    activeRuns.delete(runId)
    if (isNil(error)) {
        return
    }

    // A cancel is not a failure. `streamText` rejects on abort like any other error, so without
    // this the user who pressed stop gets "the assistant could not finish this message", the
    // conversation is left in ERROR, and everything already streamed is dropped on reload because
    // `finishRun` never ran. Persist whatever the model produced before the abort and settle IDLE.
    if (abortController.signal.aborted) {
        await finishCancelledRun({ id, platformId, userId, runId, messages, streamedText, log })
        return
    }

    // Only the error's name and message are logged, never the error object: an AI SDK
    // `APICallError` carries `requestBodyValues` and the response headers, which is where the
    // provider API key lives. The emitted payload is a fixed string for the same reason.
    log.error({
        conversationId: id,
        runId,
        errorName: error.name,
        errorMessage: error.message,
    }, '[chatAgentService#runAgentLoop] chat run failed')
    await chatConversationService.failRun({ id, platformId, userId, runId })
    emit({
        userId,
        conversationId: id,
        runId,
        event: { type: ChatAgentEventType.ERROR, data: { message: 'The assistant could not finish this message. Please try again.' } },
    })
}

function collectStreamedText({ chunk, into }: { chunk: unknown, into: string[] }): void {
    if (typeof chunk !== 'object' || isNil(chunk) || !('type' in chunk) || !('delta' in chunk)) {
        return
    }
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
        into.push(chunk.delta)
    }
}

async function finishCancelledRun({ id, platformId, userId, runId, messages, streamedText, log }: CancelledRunParams): Promise<void> {
    const text = streamedText.join('')
    await chatConversationService.finishRun({
        id,
        platformId,
        userId,
        runId,
        messages,
        // No assistant turn at all if the abort landed before the first token — an empty bubble is
        // worse than none, and `finishRun` is what returns the conversation to IDLE either way.
        assistantMessage: text.length === 0 ? null : {
            role: PersistedChatRole.ASSISTANT,
            parts: [{ type: PersistedChatPartType.TEXT, text }],
        },
    })
    log.info({ conversationId: id, runId }, '[chatAgentService#runAgentLoop] chat run cancelled by the user')
    emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.FINISHED, data: { conversationId: id } } })
}

function emit({ userId, conversationId, runId, event }: EmitParams): void {
    // Room per user id — `websocketService.init` joins every USER socket to a room named after
    // its own principal id, so this reaches that user's tabs and nobody else's.
    websocketService.to(userId).emit(WebsocketClientEvent.CHAT_MESSAGE_CHUNK, {
        conversationId,
        runId,
        type: event.type,
        data: event.data,
    })
}

async function resolveProjectId({ conversation, log }: { conversation: ChatConversation, log: FastifyBaseLogger }): Promise<string> {
    const projects = await chatProjects.accessible({
        platformId: conversation.platformId,
        userId: conversation.userId,
        log,
    })

    if (!isNil(conversation.projectId)) {
        // Re-checked on every run rather than trusted from the row: a membership revoked after
        // the conversation pinned its project must stop the tools reaching it.
        const pinned = projects.find((project) => project.id === conversation.projectId)
        if (isNil(pinned)) {
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: { message: 'You no longer have access to the project this conversation is bound to' },
            })
        }
        return pinned.id
    }

    // A conversation that has already run has a pinned project; a null one here therefore means
    // the project was deleted out from under it (the FK is ON DELETE SET NULL). Falling through to
    // "first accessible project" would silently rebind the conversation to a different tenant's
    // workspace while the replayed transcript still describes the old one.
    if (!isNil(conversation.uiMessages) && conversation.uiMessages.length > 0) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: conversation.id, entityType: 'Project' },
        })
    }

    // Same preference the rest of the repo applies when it has to choose a project for someone
    // (`projectService.getOneForUser`): their own personal project, and only then the first of the
    // list. `getAllForUser` orders by type then display name, so without this a user on a
    // multi-project platform silently gets whichever team project sorts first — and the choice is
    // permanent, since nothing in this scope can repin a conversation.
    const defaultProject = projects.find((project) => project.ownerId === conversation.userId && project.type === ProjectType.PERSONAL)
        ?? projects[0]
    if (isNil(defaultProject)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: conversation.userId, entityType: 'Project' },
        })
    }
    return defaultProject.id
}

async function buildSystemPrompt({ projectId, platformId, userId, log }: BuildSystemPromptParams): Promise<string> {
    const template = await readFile(SYSTEM_PROMPT_PATH, 'utf-8')
    // Only the one project the conversation is bound to. Listing the user's others told the model
    // about workspaces it has no tool to reach — the tools are closed over this project alone —
    // which invites it to offer something it cannot do, and puts other project names into a
    // context that has no use for them.
    const activeProject = await chatProjects.findAccessible({ projectId, platformId, userId, log })

    return template
        .replaceAll('{{PROJECT_CONTEXT}}', `You are working in the project "${activeProject?.displayName ?? projectId}" (${projectId}). Every tool call runs against it.`)
        .replaceAll('{{FRONTEND_URL}}', system.get(AppSystemProp.FRONTEND_URL) ?? '')
}

function buildUserMessage({ content, files }: SendChatMessageRequest): ModelMessage {
    if (isNil(files) || files.length === 0) {
        return { role: 'user', content }
    }
    const textParts: TextPart[] = content.length > 0 ? [{ type: 'text', text: content }] : []
    const fileParts: UserContent = [
        ...textParts,
        ...files.map((file) => ({
            type: 'file' as const,
            data: file.data,
            mediaType: file.mimeType,
            filename: file.name,
        })),
    ]
    return { role: 'user', content: fileParts }
}

function toContentParts(steps: StepResult<ToolSet>[]): ContentPartLike[] {
    return steps.flatMap((step) => step.content.map((part) => ({
        type: part.type,
        ...spreadIfDefined('text', 'text' in part ? part.text : undefined),
        ...spreadIfDefined('toolCallId', 'toolCallId' in part ? part.toolCallId : undefined),
        ...spreadIfDefined('toolName', 'toolName' in part ? part.toolName : undefined),
        ...spreadIfDefined('input', 'input' in part ? part.input : undefined),
        ...spreadIfDefined('output', 'output' in part ? part.output : undefined),
        // A failed tool call carries its detail on `error`; `buildStepParts` reads it from
        // `output`, so it is folded in here rather than special-cased there.
        ...spreadIfDefined('output', 'error' in part ? part.error : undefined),
        // A tool approval request carries no flat `toolCallId`/`toolName`/`input` at all — the
        // gated call is nested under `toolCall` — so without these two the part arrives at
        // `buildStepParts` as a bare type with nothing to persist.
        ...spreadIfDefined('approvalId', 'approvalId' in part ? part.approvalId : undefined),
        ...spreadIfDefined('toolCall', 'toolCall' in part ? part.toolCall : undefined),
    })))
}

type GetRunParams = {
    id: string
    platformId: string
    userId: string
}

type StartParams = {
    id: string
    platformId: string
    userId: string
    request: SendChatMessageRequest
}

type RunLoopParams = {
    id: string
    platformId: string
    userId: string
    runId: string
    resolvedModel: ResolvedChatModel
    systemPrompt: string
    messages: ModelMessage[]
    tools: ToolSet
    log: FastifyBaseLogger
}

type CancelledRunParams = {
    id: string
    platformId: string
    userId: string
    runId: string
    messages: ModelMessage[]
    streamedText: string[]
    log: FastifyBaseLogger
}

type EmitParams = {
    userId: string
    conversationId: string
    runId: string
    event: ChatAgentEvent
}

type BuildSystemPromptParams = {
    projectId: string
    platformId: string
    userId: string
    log: FastifyBaseLogger
}

export type StartChatRunResponse = {
    conversationId: string
    runId: string
}

import { readFile } from 'node:fs/promises'
import { chatAiUtils, ContentPartLike } from '@aiqadam/server-utils'
import {
    apId,
    ChatAgentEvent,
    ChatAgentEventType,
    ChatConversation,
    ErrorCode,
    isNil,
    PersistedChatMessage,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedChatRole,
    Project,
    ProjectScopedMcpServer,
    QadamFlowError,
    SendChatMessageRequest,
    spreadIfDefined,
    tryCatch,
    WebsocketClientEvent,
} from '@aiqadam/shared'
import { ModelMessage, stepCountIs, StepResult, streamText, TextPart, ToolCallPart, ToolResultPart, ToolSet, UserContent } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { websocketService } from '../core/websockets.service'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { mcpServerService } from '../mcp/mcp-service'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { chatConversationService } from './chat-conversation.service'
import { chatModel, ResolvedChatModel } from './chat-model'
import { chatTools } from './chat-tools'

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
            ...toModelMessages(conversation.uiMessages ?? []),
            buildUserMessage(request),
        ]

        await chatConversationService.startRun({
            id,
            platformId,
            userId,
            projectId,
            userMessage: { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: request.content }] },
        })

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
    cancel({ id }: { id: string }): void {
        activeRuns.get(id)?.abort()
    },
})

const activeRuns = new Map<string, AbortController>()

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
    activeRuns.set(id, abortController)

    const { error } = await tryCatch(async () => {
        const result = streamText({
            model: resolvedModel.model,
            system: chatAiUtils.buildSystemPromptWithCaching({ systemPrompt, provider: resolvedModel.provider }),
            messages,
            tools,
            stopWhen: stepCountIs(MAX_AGENT_STEPS),
            abortSignal: abortController.signal,
        })

        for await (const chunk of result.toUIMessageStream()) {
            emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.CHUNK, data: chunk } })
        }

        const steps = await result.steps
        const response = await result.response
        await chatConversationService.finishRun({
            id,
            platformId,
            userId,
            messages: [...messages, ...response.messages],
            assistantMessage: {
                role: PersistedChatRole.ASSISTANT,
                parts: chatAiUtils.buildStepParts({ content: toContentParts(steps) }),
            },
        })
        emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.FINISHED, data: { conversationId: id } } })
    })

    activeRuns.delete(id)
    if (isNil(error)) {
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
    await chatConversationService.failRun({ id, platformId, userId })
    emit({
        userId,
        conversationId: id,
        runId,
        event: { type: ChatAgentEventType.ERROR, data: { message: 'The assistant could not finish this message. Please try again.' } },
    })
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

// Deliberately the same list the projects page shows the user (project-controller.ts:43): the
// chat must never reach a project the user could not open themselves, and must not refuse one
// they can.
async function accessibleProjects({ platformId, userId, log }: AccessibleProjectsParams): Promise<Project[]> {
    const user = await userService(log).getOneOrFail({ id: userId })
    return projectService(log).getAllForUser({
        platformId,
        userId,
        isPrivileged: userService(log).isUserPrivileged(user),
    })
}

async function resolveProjectId({ conversation, log }: { conversation: ChatConversation, log: FastifyBaseLogger }): Promise<string> {
    const projects = await accessibleProjects({
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

    const [firstProject] = projects
    if (isNil(firstProject)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: { entityId: conversation.id, entityType: 'Project' },
        })
    }
    return firstProject.id
}

async function buildSystemPrompt({ projectId, platformId, userId, log }: BuildSystemPromptParams): Promise<string> {
    const template = await readFile(SYSTEM_PROMPT_PATH, 'utf-8')
    const projects = await accessibleProjects({ platformId, userId, log })
    const activeProject = projects.find((project) => project.id === projectId)
    const projectList = projects.map((project) => `- ${project.displayName} (${project.id})`).join('\n')

    return template
        .replaceAll('{{PROJECT_LIST}}', projectList)
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

// The replay transcript is rebuilt from `uiMessages`, which is a schema-validated shape we own,
// rather than from the raw `messages` JSON blob. Nothing is lost by it: `chatAiUtils`
// deliberately strips cross-turn reasoning for every provider anyway, and the tool-call/result
// pairs survive intact. `messages` stays as the persisted record of what was last sent.
function toModelMessages(uiMessages: PersistedChatMessage[]): ModelMessage[] {
    return uiMessages.flatMap((message) => message.role === PersistedChatRole.USER
        ? toUserModelMessages(message.parts)
        : toAssistantModelMessages(message.parts))
}

function toUserModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const text = parts
        .flatMap((part) => part.type === PersistedChatPartType.TEXT ? [part.text] : [])
        .join('\n')
    return text.length === 0 ? [] : [{ role: 'user', content: text }]
}

function toAssistantModelMessages(parts: PersistedChatPart[]): ModelMessage[] {
    const content: Array<TextPart | ToolCallPart> = []
    const toolResults: ToolResultPart[] = []

    for (const part of parts) {
        if (part.type === PersistedChatPartType.TEXT) {
            content.push({ type: 'text', text: part.text })
        }
        if (part.type === PersistedChatPartType.TOOL_CALL) {
            content.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
            toolResults.push({
                type: 'tool-result',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                // Serialised as text rather than `{ type: 'json' }` because the persisted output
                // is `unknown` and the JSON variant demands a proven `JSONValue`.
                output: { type: 'text', value: JSON.stringify(part.output ?? null) },
            })
        }
    }

    if (content.length === 0) {
        return []
    }
    // A tool message must follow the assistant message that made the calls, or the provider
    // rejects the transcript for having unanswered tool calls.
    return toolResults.length === 0
        ? [{ role: 'assistant', content }]
        : [{ role: 'assistant', content }, { role: 'tool', content: toolResults }]
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
    })))
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

type EmitParams = {
    userId: string
    conversationId: string
    runId: string
    event: ChatAgentEvent
}

type AccessibleProjectsParams = {
    platformId: string
    userId: string
    log: FastifyBaseLogger
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

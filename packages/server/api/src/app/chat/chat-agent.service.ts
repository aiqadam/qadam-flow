import { readFile } from 'node:fs/promises'
import { SharedV3ProviderOptions } from '@ai-sdk/provider'
import { chatAiUtils, ContentPartLike } from '@aiqadam/server-utils'
import {
    AnswerChatToolApprovalRequest,
    apId,
    ChatAgentEvent,
    ChatAgentEventType,
    ChatContextUsage,
    ChatContextUsageSchema,
    chatContextUtils,
    ChatConversation,
    ErrorCode,
    isNil,
    PersistedChatMessage,
    PersistedChatPartType,
    PersistedChatRole,
    ProjectScopedMcpServer,
    ProjectType,
    QadamFlowError,
    SendChatMessageRequest,
    spreadIfDefined,
    ToolApprovalRequestEvent,
    tryCatch,
    WebsocketClientEvent,
} from '@aiqadam/shared'
import { ModelMessage, NoOutputGeneratedError, stepCountIs, StepResult, streamText, SystemModelMessage, TextPart, ToolSet, UserContent } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { websocketService } from '../core/websockets.service'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { mcpServerService } from '../mcp/mcp-service'
import { qadamMetadataService } from '../qadams/metadata/qadam-metadata-service'
import { chatApprovals } from './chat-approvals'
import { chatCompaction } from './chat-compaction'
import { chatContextUsage } from './chat-context-usage'
import { chatConversationService } from './chat-conversation.service'
import { CHAT_ERROR_CODES, classifyChatError, describeChatError } from './chat-error-classify'
import { chatModel, ResolvedChatModel } from './chat-model'
import { chatProjects } from './chat-projects'
import { chatThinkingDuration } from './chat-thinking-duration'
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

        const { displacedRunId, uiMessages } = await chatConversationService.startRun({
            id,
            platformId,
            userId,
            projectId,
            runId,
            log,
            userMessage: { role: PersistedChatRole.USER, parts: [{ type: PersistedChatPartType.TEXT, text: request.content }] },
        })

        // Composed from what admission actually wrote rather than from the row read above, because
        // admitting a message auto-denies any gate still waiting and that denial lands on an older
        // message. The just-appended user turn is dropped and rebuilt by `buildUserMessage`, which
        // is the only path that can carry attachments — the persisted turn is text alone.
        const transcript = buildRunTranscript({ conversation, uiMessages: uiMessages.slice(0, -1), request, resumingGate: false })

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
            transcript,
            // Rebuilt from the re-read row rather than from `uiMessages`: the overflow safety net moves
            // the row's transcript start, and the retry has to replay from the new one. The admitted
            // user turn is still the row's last message — the run that appends the reply is this one.
            rebuildTranscript: (fresh) => buildRunTranscript({ conversation: fresh, uiMessages: (fresh.uiMessages ?? []).slice(0, -1), request, resumingGate: false }),
            tools,
            providerOptions: resolvedModel.reasoningProviderOptions,
            log,
        }), log)

        return { conversationId: id, runId }
    },

    /**
     * Answers one gate and resumes the run it stopped.
     *
     * Ownership is proven by `getOneOrThrow` — `{ id, platformId, userId }` — *before* anything looks
     * for the approval, and the approval is then looked for inside that row alone. The inverse shape,
     * "find the conversation holding approval X", would authorise on knowledge of an id that appears
     * in a socket payload and a card, which is not a secret. Route order matters for the same reason:
     * the gate id is a path segment *under* the conversation, so there is no way to reach this
     * without naming a conversation the caller can already open.
     *
     * The tool is not executed here. `collectToolApprovals` executes it inside the resumed
     * `streamText` call (`ai/dist/index.mjs:7013`); doing it here as well would run it twice.
     */
    async approve({ id, platformId, userId, approvalId, request }: ApproveParams): Promise<StartChatRunResponse> {
        const conversation = await chatConversationService.getOneOrThrow({ id, platformId, userId })
        // Before any of the resolution below, so a gate that cannot be answered is reported as
        // itself. It is re-checked under the row lock inside `startRun`, which is the check that
        // counts; this one only picks the right error to answer with.
        chatApprovals.assertAnswerable({
            uiMessages: conversation.uiMessages,
            approvalId,
            expectedToolCallId: request.toolCallId,
        })
        const projectId = await resolveProjectId({ conversation, log })
        const resolvedModel = await chatModel.resolve({ platformId, modelName: conversation.modelName, log })

        const mcp = await mcpServerService(log).getByProjectId(projectId)
        const projectScopedMcp: ProjectScopedMcpServer = { ...mcp, projectId }
        const tools = await chatTools.build({ mcp: projectScopedMcp, userId, log })
        const systemPrompt = await buildSystemPrompt({ projectId, platformId, userId, log })

        const runId = apId()
        const { displacedRunId, uiMessages } = await chatConversationService.startRun({
            id,
            platformId,
            userId,
            projectId,
            runId,
            log,
            userMessage: null,
            approval: {
                approvalId,
                approved: request.approved,
                reason: request.reason,
                expectedToolCallId: request.toolCallId,
            },
        })

        abortRun(displacedRunId)

        rejectedPromiseHandler(runAgentLoop({
            id,
            platformId,
            userId,
            runId,
            resolvedModel,
            systemPrompt,
            // No user turn is appended, so the transcript ends on the tool message carrying the
            // response — the only arrangement in which `collectToolApprovals` reads it at all
            // (`ai/dist/index.mjs:2690`: it returns empty unless the last message is a tool message).
            // `resumingGate` is set ONLY here: this is the one run that must leave the settled gate
            // without a tool result, because a result would make `collectToolApprovals` skip the
            // call (`:2737`) and the approved tool would silently never execute. Every other run —
            // `start` included, which is where an auto-denied gate is replayed — must answer it, or
            // the provider rejects an assistant `tool-call` that nothing responds to.
            transcript: buildRunTranscript({ conversation, uiMessages, request: null, resumingGate: true }),
            rebuildTranscript: (fresh) => buildRunTranscript({ conversation: fresh, uiMessages: fresh.uiMessages ?? [], request: null, resumingGate: true }),
            tools,
            // Never asked to reason, even on a row that opted in (#566). A resumed run continues the
            // turn the gate interrupted, and the transcript replays that turn's `tool_use` without
            // the thinking block it began with — reasoning is never persisted with a signature. In
            // Anthropic's budgeted mode the final assistant turn of a thinking request must begin
            // with that block, and a thinking setting that changes mid-turn is at best silently
            // switched off by the provider. Sent without it, the request is the one this path has
            // always sent. Not verified against a live provider.
            providerOptions: null,
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

export async function buildSystemPrompt({ projectId, platformId, userId, log }: BuildSystemPromptParams): Promise<string> {
    const template = await readFile(SYSTEM_PROMPT_PATH, 'utf-8')
    // Only the one project the conversation is bound to. Listing the user's others told the model
    // about workspaces it has no tool to reach — the tools are closed over this project alone —
    // which invites it to offer something it cannot do, and puts other project names into a
    // context that has no use for them.
    const activeProject = await chatProjects.findAccessible({ projectId, platformId, userId, log })
    const installedQadams = await installedQadamCount({ projectId, platformId, log })

    return template
        .replaceAll('{{PROJECT_CONTEXT}}', `You are working in the project "${activeProject?.displayName ?? projectId}" (${projectId}). Every tool call runs against it.`)
        .replaceAll('{{FRONTEND_URL}}', system.get(AppSystemProp.FRONTEND_URL) ?? '')
        .replaceAll('{{INTEGRATION_COUNT}}', String(installedQadams))
}

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

// One controller for the whole run, overflow retry included: were it dropped between the refused
// attempt and the retry, a Stop or a takeover landing while the pass compacts would find nothing to
// abort, and the retry would stream a reply the user had stopped — or run beside the run that took
// the conversation over.
//
// The thinking clock is per run too, for the same reason: the user watches one "Thinking..." from the
// refused attempt through the compaction pass to the retry, and the browser, which cannot see where
// one ends and the next begins, measures all of it. A run resumed from an approval is a run of its
// own, so its clock starts at the resume and the time the gate waited on a human is never counted.
async function runAgentLoop(params: RunLoopParams): Promise<void> {
    const abortController = new AbortController()
    activeRuns.set(params.runId, abortController)
    try {
        await runAttempt({ ...params, abortController, retriedAfterOverflow: false, startedAt: performance.now() })
    }
    finally {
        activeRuns.delete(params.runId)
    }
}

async function runAttempt(params: RunAttemptParams): Promise<void> {
    const { id, platformId, userId, runId, resolvedModel, systemPrompt, transcript, tools, abortController, retriedAfterOverflow, startedAt, log } = params
    const { messages } = transcript
    const cachedSystemPrompt = chatAiUtils.buildSystemPromptWithCaching({ systemPrompt, provider: resolvedModel.provider })
    const streamedText: string[] = []
    // Per attempt, not per run: the reply that gets persisted is this attempt's, so its first text is.
    let replyStartedAt: number | null = null
    // Once a tool has run, a retry would run it again — the overflow safety net must not.
    let toolExecuted = false
    // The SDK's `tool-approval-request` UI chunk carries `{ type, approvalId, toolCallId }` and
    // nothing else (`ai/dist/index.mjs:5136-5140`), but the card is useless without the tool and its
    // arguments. The gated call's `tool-input-available` chunk is enqueued *before* the approval
    // check (`:6226` then `:6264`), so by the time the request arrives its input has already gone
    // past — correlated by `toolCallId` here rather than re-read from the database, which the row
    // does not yet contain.
    const gatedCallInputs = new Map<string, { toolName: string, input: Record<string, unknown> }>()
    // `streamText` does not throw a provider failure: it hands it to `onError` and carries on, and
    // when the very first step never produced anything, `result.steps` then rejects with a
    // `NoOutputGeneratedError` whose message is a fixed "No output generated. Check the stream for
    // errors." Classifying and logging that wrapper is what left every provider failure reported as
    // UNKNOWN — timeouts, SSRF blocks and "model does not support tools" alike. The first error is
    // kept because it is the cause; anything after it is fallout. Without an `onError` the SDK's
    // default `console.error`s the whole error, request body included, past the logger's redaction.
    let providerError: unknown = undefined

    const { error } = await tryCatch(async () => {
        const result = streamText({
            model: resolvedModel.model,
            // The summary goes through `system` rather than `messages`: the SDK `console.warn`s on
            // every call that carries a system message in `messages`, past the logger.
            system: isNil(transcript.summaryMessage) ? cachedSystemPrompt : [toSystemMessage(cachedSystemPrompt), transcript.summaryMessage],
            messages,
            tools,
            // Spread rather than passed as `undefined` so a run that does not reason builds the
            // same call it built before the setting existed (#566).
            ...spreadIfDefined('providerOptions', params.providerOptions ?? undefined),
            stopWhen: stepCountIs(MAX_AGENT_STEPS),
            abortSignal: abortController.signal,
            onError: ({ error: streamError }) => {
                providerError ??= streamError
            },
            // Proof of life for `isAbandoned`. Without it a long run looks identical to one whose
            // process died, and the staleness window would have to be longer than the longest
            // possible run to be safe — which would make it useless.
            onStepFinish: () => {
                rejectedPromiseHandler(chatConversationService.touchRun({ id, platformId, userId, runId }), log)
            },
        })

        for await (const chunk of result.toUIMessageStream()) {
            // The SDK fills an `error` chunk through `getErrorMessage`: the provider's raw message,
            // or a non-Error rejection's whole `JSON.stringify`. The client learns about a failed
            // run from the classified ERROR event below and its reducer ignores this chunk, so it
            // is not forwarded at all. Overriding `toUIMessageStream`'s `onError` instead is not
            // an option: the same callback writes every failed tool call's `errorText`, which the
            // tool cards display, and would turn each of them into a turn-failed message.
            if (isStreamErrorChunk(chunk)) {
                continue
            }
            // Accumulated as it goes rather than read off `result` at the end, because on an abort
            // `result.steps` rejects along with the stream — this is the only copy of the partial
            // reply that survives a cancel.
            collectStreamedText({ chunk, into: streamedText })
            if (isNil(replyStartedAt) && chatThinkingDuration.isReplyText(chunk)) {
                replyStartedAt = performance.now()
            }
            toolExecuted ||= isToolOutputChunk(chunk)
            emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.CHUNK, data: chunk } })
            const approvalEvent = trackToolApproval({ chunk, gatedCallInputs })
            if (!isNil(approvalEvent)) {
                emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.TOOL_APPROVAL_REQUEST, data: approvalEvent } })
            }
        }

        const thinkingDurationMs = chatThinkingDuration.measure({ startedAt, replyStartedAt, endedAt: performance.now() })
        const steps = await result.steps
        const response = await result.response
        const contextUsage = await measureContextUsage({ resolvedModel, systemPrompt, transcript, tools, responseMessages: response.messages, steps, conversationId: id, runId, log })
        await chatConversationService.finishRun({
            id,
            platformId,
            userId,
            runId,
            messages: [...messages, ...response.messages],
            assistantMessage: {
                role: PersistedChatRole.ASSISTANT,
                parts: chatAiUtils.buildStepParts({ content: toContentParts(steps) }),
                thinkingDurationMs,
                ...spreadIfDefined('contextUsage', contextUsage ?? undefined),
            },
        })
        emit({ userId, conversationId: id, runId, event: { type: ChatAgentEventType.FINISHED, data: { conversationId: id } } })
        // After FINISHED, so the user never waits on it, and without awaiting: the next turn needs
        // only what is on the row when it is admitted, and a pass still running then is harmless
        // (`saveCompaction` is conditional on the boundary it started from).
        rejectedPromiseHandler(chatCompaction(log).compactAfterReply({ id, platformId, userId, resolvedModel }), log)
    })

    if (isNil(error)) {
        // A step after the first can fail too — a 429 or a context overflow a few tool rounds in —
        // and then `result.steps` resolves with what came before and the run settles as a success
        // with a cut-off reply. The SDK's `console.error` used to be the only trace of that; with
        // `onError` taken over, this is.
        if (!isNil(providerError)) {
            const { name: errorName, message: errorMessage, statusCode: errorStatusCode } = describeChatError(providerError)
            log.warn({
                conversationId: id,
                runId,
                errorCode: classifyChatError(providerError).code,
                errorName,
                errorMessage,
                errorStatusCode,
            }, '[chatAgentService#runAgentLoop] provider failed after the first step; the reply is partial')
        }
        return
    }

    // A cancel is not a failure. `streamText` rejects on abort like any other error, so without
    // this the user who pressed stop gets "the assistant could not finish this message", the
    // conversation is left in ERROR, and everything already streamed is dropped on reload because
    // `finishRun` never ran. Persist whatever the model produced before the abort and settle IDLE.
    if (abortController.signal.aborted) {
        await finishCancelledRun({ id, platformId, userId, runId, messages, streamedText, startedAt, replyStartedAt, log })
        return
    }

    // The captured error is the cause only when the SDK reports that nothing was produced — the
    // one rejection it raises in place of the provider's. Anything else that threw here (e.g.
    // `finishRun` failing after a later step's provider error) is its own cause.
    const cause = NoOutputGeneratedError.isInstance(error) && !isNil(providerError) ? providerError : error
    // The safety net for a window the measurements got wrong (#567): shorten the transcript and try
    // the turn once more. Only before any tool ran, since the retry replays the turn from the start,
    // and only once, since a second refusal means shortening did not help.
    if (!retriedAfterOverflow && !toolExecuted && classifyChatError(cause).code === CHAT_ERROR_CODES.PROVIDER_CONTEXT_LENGTH_EXCEEDED) {
        const outcome = await retryAfterOverflow(params)
        if (outcome === RetryOutcome.RETRIED) {
            return
        }
        // Stopped or taken over while the pass compacted: the turn settles as the cancel it is
        // rather than as the refusal it no longer is. After a takeover `finishRun` matches no row.
        if (outcome === RetryOutcome.STOPPED) {
            await finishCancelledRun({ id, platformId, userId, runId, messages, streamedText, startedAt, replyStartedAt, log })
            return
        }
    }
    // Only the error's name, message and HTTP status are read, never the error object: an AI SDK
    // `APICallError` carries `requestBodyValues` and the response headers, which is where the
    // provider API key lives. classifyChatError is deliberately pure and reads the same three, so
    // the user-facing payload stays a fixed string per class (DoD 3 of #265).
    const { code, message } = classifyChatError(cause)
    const { name: errorName, message: errorMessage, statusCode: errorStatusCode } = describeChatError(cause)
    log.error({
        conversationId: id,
        runId,
        errorCode: code,
        errorName,
        errorMessage,
        errorStatusCode,
        ...spreadIfDefined('wrapperErrorName', cause === error ? undefined : error.name),
    }, '[chatAgentService#runAgentLoop] chat run failed')
    // Classified before failRun is persisted: the ERROR status then proves the classifier
    // ran without throwing (it is total — any input maps to a code), so an integration
    // test asserting ERROR also pins the classified path, not just the failure itself.
    await chatConversationService.failRun({ id, platformId, userId, runId })
    emit({
        userId,
        conversationId: id,
        runId,
        event: { type: ChatAgentEventType.ERROR, data: { message, code } },
    })
}

// Narrowed off `unknown` for the same reason `collectStreamedText` is: the stream's element type is
// generic over the UI message shape, and reading fields off it directly needs a cast this repo
// forbids. Returns the event to emit rather than emitting, so the caller keeps the one socket path.
function trackToolApproval({ chunk, gatedCallInputs }: TrackApprovalParams): ToolApprovalRequestEvent | null {
    if (typeof chunk !== 'object' || isNil(chunk) || !('type' in chunk)) {
        return null
    }
    if (chunk.type === 'tool-input-available' && 'toolCallId' in chunk && typeof chunk.toolCallId === 'string' && 'toolName' in chunk && typeof chunk.toolName === 'string') {
        gatedCallInputs.set(chunk.toolCallId, {
            toolName: chunk.toolName,
            input: 'input' in chunk ? toInputRecord(chunk.input) : {},
        })
        return null
    }
    if (chunk.type !== 'tool-approval-request' || !('approvalId' in chunk) || typeof chunk.approvalId !== 'string' || !('toolCallId' in chunk) || typeof chunk.toolCallId !== 'string') {
        return null
    }
    const gatedCall = gatedCallInputs.get(chunk.toolCallId)
    if (isNil(gatedCall)) {
        return null
    }
    return {
        approvalId: chunk.approvalId,
        toolCallId: chunk.toolCallId,
        toolName: gatedCall.toolName,
        displayName: chatApprovals.toDisplayName(gatedCall.toolName),
        toolInput: gatedCall.input,
    }
}

function isStreamErrorChunk(chunk: unknown): boolean {
    return typeof chunk === 'object' && !isNil(chunk) && 'type' in chunk && chunk.type === 'error'
}

function toInputRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || isNil(value) || Array.isArray(value)) {
        return {}
    }
    return { ...value }
}

function collectStreamedText({ chunk, into }: { chunk: unknown, into: string[] }): void {
    if (typeof chunk !== 'object' || isNil(chunk) || !('type' in chunk) || !('delta' in chunk)) {
        return
    }
    if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
        into.push(chunk.delta)
    }
}

async function finishCancelledRun({ id, platformId, userId, runId, messages, streamedText, startedAt, replyStartedAt, log }: CancelledRunParams): Promise<void> {
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
            thinkingDurationMs: chatThinkingDuration.measure({ startedAt, replyStartedAt, endedAt: performance.now() }),
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
    // permanent once this run pins it, since a conversation can only be repinned while it is still
    // empty (`repinProject`).
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

// `buildSystemPrompt` runs on every message send and every tool-approval resume (both call sites
// above), ahead of the first token — so a naive `qadamMetadataService.list()` on every call would
// put a full scan-and-hydrate of `qadam_metadata` (`fetchLatestCompatiblePiecesFromDB`, then a
// second `find` hydrating every row's full actions/triggers JSON, then a sort+search pass) on the
// critical path of every single turn. `qadamMetadataService`'s own `dedupe()` only collapses
// *concurrent* calls — it deletes its key in a `finally`, so it is not a cache across turns. A
// short TTL is enough: this number only has to be honest to within the length of one conversation,
// never to the millisecond, and it re-reads within a minute of a qadam being installed/removed.
const INTEGRATION_COUNT_CACHE_TTL_MS = 60_000
const integrationCountCache = new Map<string, { count: number, expiresAt: number }>()

async function installedQadamCount({ projectId, platformId, log }: InstalledQadamCountParams): Promise<number> {
    const cached = integrationCountCache.get(platformId)
    if (!isNil(cached) && cached.expiresAt > Date.now()) {
        return cached.count
    }
    // `list()` scopes to official qadams plus this platform's own CUSTOM ones
    // (`filterQadamBasedOnType`), so the catalogue size the assistant claims matches what this
    // platform actually has installed, not the repo's total piece count. `projectId` is passed
    // through for interface parity with the other `list()` call sites (e.g. `ap-research-qadams.ts`)
    // — it plays no role in the current filtering.
    const installedQadams = await qadamMetadataService(log).list({ projectId, platformId, includeHidden: false })
    integrationCountCache.set(platformId, { count: installedQadams.length, expiresAt: Date.now() + INTEGRATION_COUNT_CACHE_TTL_MS })
    return installedQadams.length
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

async function retryAfterOverflow(params: RunAttemptParams): Promise<RetryOutcome> {
    const { id, platformId, userId, runId, resolvedModel, rebuildTranscript, abortController, log } = params
    const compacted = await chatCompaction(log).compactForOverflow({
        id,
        platformId,
        userId,
        resolvedModel,
        abortSignal: abortController.signal,
        heartbeat: () => rejectedPromiseHandler(chatConversationService.touchRun({ id, platformId, userId, runId }), log),
    })
    if (abortController.signal.aborted) {
        return RetryOutcome.STOPPED
    }
    // A cancel handled by another process, or a takeover, rewrites the row without reaching this
    // controller. The run is then no longer wanted — whether or not the pass shortened anything, so
    // a stopped turn never settles as a failed one — and a retry would be a second loop on the row.
    // Its own read because `activeRunId` is deliberately not in the `ChatConversation` contract.
    const { data: isActive, error: activeError } = await tryCatch(() => chatConversationService.isRunActive({ id, platformId, userId, runId }))
    if (isNil(activeError) && isActive === false) {
        log.info({ conversationId: id, runId }, '[chatAgentService#runAgentLoop] the run was stopped or taken over while compacting; not retrying')
        return RetryOutcome.STOPPED
    }
    if (!compacted || !isNil(activeError)) {
        return RetryOutcome.FAILED
    }
    const { data: fresh, error } = await tryCatch(() => chatConversationService.getOneOrThrow({ id, platformId, userId }))
    if (!isNil(error) || isNil(fresh)) {
        log.warn({ conversationId: id, runId, errorName: error?.name }, '[chatAgentService#runAgentLoop] could not rebuild the transcript after compacting; the turn fails')
        return RetryOutcome.FAILED
    }
    log.info({ conversationId: id, runId }, '[chatAgentService#runAgentLoop] the provider refused the turn as too long; retrying once on a compacted transcript')
    await runAttempt({ ...params, transcript: rebuildTranscript(fresh), retriedAfterOverflow: true })
    return RetryOutcome.RETRIED
}

function toSystemMessage(system: string | SystemModelMessage): SystemModelMessage {
    return typeof system === 'string' ? { role: 'system', content: system } : system
}

// What a run sends: the summary standing for what the transcript's start has passed over (#567), the
// replayed messages, and — for a run started by a message — the new user turn, rebuilt here because it
// is the only path that can carry attachments.
function buildRunTranscript({ conversation, uiMessages, request, resumingGate }: BuildRunTranscriptParams): RunTranscript {
    const summarizedUpToIndex = conversation.summarizedUpToIndex ?? null
    const replayed = chatTranscript.toModelMessages(uiMessages, { summarizedUpToIndex, resumingGate })
    return {
        messages: isNil(request) ? replayed : [...replayed, buildUserMessage(request)],
        summaryMessage: chatTranscript.summaryMessage({ summary: conversation.summary ?? null, autoCompact: conversation.autoCompact }),
        startIndex: chatContextUtils.transcriptStart({ messages: uiMessages, summarizedUpToIndex }),
    }
}

function isToolOutputChunk(chunk: unknown): boolean {
    return typeof chunk === 'object' && !isNil(chunk) && 'type' in chunk
        && (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error')
}

// The popover is a view on the run, never a reason for it to fail: a measurement that throws is
// logged and the reply is persisted without one.
async function measureContextUsage({ resolvedModel, systemPrompt, transcript, tools, responseMessages, steps, conversationId, runId, log }: MeasureContextUsageParams): Promise<ChatContextUsage | null> {
    const lastStep = steps.at(-1)
    if (isNil(lastStep)) {
        return null
    }
    const { data, error } = await tryCatch(() => chatContextUsage.measure({
        modelId: resolvedModel.modelId,
        contextWindowTokens: resolvedModel.contextWindowTokens,
        systemPrompt,
        summary: transcript.summaryMessage?.content ?? null,
        tools,
        history: [...transcript.messages, ...responseMessages],
        lastStepUsage: lastStep.usage,
        transcriptStartIndex: transcript.startIndex,
    }))
    if (!isNil(error)) {
        log.warn({ conversationId, runId, errorName: error.name }, '[chatAgentService#runAgentLoop] could not measure the context usage; the reply is saved without it')
        return null
    }
    // The counts come from the provider's stream, which the SDK only checks for being numbers; a
    // CUSTOM endpoint can report a negative or fractional one. Saved only if it fits the schema the
    // browser reads it back through.
    const parsed = ChatContextUsageSchema.safeParse(data)
    if (!parsed.success) {
        log.warn({ conversationId, runId, modelId: resolvedModel.modelId }, '[chatAgentService#runAgentLoop] the provider reported token counts that do not fit the schema; the reply is saved without a context measurement')
        return null
    }
    return parsed.data
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

type ApproveParams = {
    id: string
    platformId: string
    userId: string
    approvalId: string
    request: AnswerChatToolApprovalRequest
}

type TrackApprovalParams = {
    chunk: unknown
    gatedCallInputs: Map<string, { toolName: string, input: Record<string, unknown> }>
}

type RunLoopParams = {
    id: string
    platformId: string
    userId: string
    runId: string
    resolvedModel: ResolvedChatModel
    systemPrompt: string
    transcript: RunTranscript
    rebuildTranscript: (fresh: ChatConversation) => RunTranscript
    tools: ToolSet
    // Reasoning is asked for through these alone; null when the run must not reason.
    providerOptions: SharedV3ProviderOptions | null
    log: FastifyBaseLogger
}

type RunAttemptParams = RunLoopParams & {
    abortController: AbortController
    retriedAfterOverflow: boolean
    // `performance.now()` at the run's start: monotonic, so a wall-clock step cannot skew the label.
    startedAt: number
}

type RunTranscript = {
    messages: ModelMessage[]
    summaryMessage: SystemModelMessage | null
    // Where `messages` began in `uiMessages`, recorded with the measurement.
    startIndex: number
}

type BuildRunTranscriptParams = {
    conversation: ChatConversation
    uiMessages: PersistedChatMessage[]
    request: SendChatMessageRequest | null
    resumingGate: boolean
}

type CancelledRunParams = {
    id: string
    platformId: string
    userId: string
    runId: string
    messages: ModelMessage[]
    streamedText: string[]
    startedAt: number
    replyStartedAt: number | null
    log: FastifyBaseLogger
}

type MeasureContextUsageParams = {
    resolvedModel: ResolvedChatModel
    systemPrompt: string
    transcript: RunTranscript
    tools: ToolSet
    responseMessages: ModelMessage[]
    steps: StepResult<ToolSet>[]
    conversationId: string
    runId: string
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

type InstalledQadamCountParams = {
    projectId: string
    platformId: string
    log: FastifyBaseLogger
}

export type StartChatRunResponse = {
    conversationId: string
    runId: string
}

enum RetryOutcome {
    RETRIED = 'RETRIED',
    STOPPED = 'STOPPED',
    FAILED = 'FAILED',
}

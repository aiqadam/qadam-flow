import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { SharedV3ProviderOptions } from '@ai-sdk/provider'
import {
    AIProviderName,
    AzureProviderConfig,
    BaseAIProviderAuthConfig,
    BatchProgressData,
    BedrockProviderAuthConfig,
    BedrockProviderConfig,
    chatPersistenceUtils,
    CloudflareGatewayProviderConfig,
    INVALID_AWS_REGION_MESSAGE,
    INVALID_AZURE_RESOURCE_NAME_MESSAGE,
    isBatchProgressData,
    isNil,
    isValidAwsRegion,
    isValidAzureResourceName,
    OpenAICompatibleProviderConfig,
    PersistedChatPart,
    PersistedChatPartType,
    PersistedToolCallStatus,
    splitCloudflareGatewayModelId,
    spreadIfDefined,
} from '@aiqadam/shared'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { LanguageModel, ModelMessage, SystemModelMessage } from 'ai'
import { safeHttp } from './safe-http'

// Every provider gets `fetch: safeHttp.fetch`, not just CUSTOM. CUSTOM is the obvious SSRF case —
// its `baseUrl` is admin config — but AZURE (`resourceName`) and CLOUDFLARE_GATEWAY
// (`accountId`/`gatewayId`) also interpolate operator-supplied values into the URL, and
// `.claude/rules/safe-http.md` requires the filtered client even for fixed, trusted endpoints.
// Operators pointing chat at an in-cluster model server must allow-list it via AP_SSRF_ALLOW_LIST.

function createChatModel({ provider, auth, config, modelId }: {
    provider: AIProviderName
    auth: Record<string, unknown>
    config: Record<string, unknown>
    modelId: string
}): LanguageModel {
    switch (provider) {
        case AIProviderName.OPENAI: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            return createOpenAI({ apiKey, fetch: safeHttp.fetch }).chat(modelId)
        }
        case AIProviderName.ANTHROPIC: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            return createAnthropic({ apiKey, fetch: safeHttp.fetch })(modelId)
        }
        case AIProviderName.GOOGLE: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            return createGoogleGenerativeAI({ apiKey, fetch: safeHttp.fetch })(modelId)
        }
        case AIProviderName.AZURE: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { resourceName } = config as AzureProviderConfig
            // The schema rejects a `resourceName` that could move the host, but this row is read
            // straight from the database and never re-parsed, so a value stored before that
            // constraint existed would still reach `https://<it>.openai.azure.com` with the
            // `api-key` header attached (#276). safeHttp.fetch filters the address, not the name.
            if (!isValidAzureResourceName(resourceName)) {
                throw new Error(INVALID_AZURE_RESOURCE_NAME_MESSAGE)
            }
            return createAzure({ resourceName, apiKey, fetch: safeHttp.fetch }).chat(modelId)
        }
        case AIProviderName.BEDROCK: {
            const { accessKeyId, secretAccessKey } = auth as BedrockProviderAuthConfig
            const { region } = config as BedrockProviderConfig
            // Same reason as AZURE above: the SDK interpolates `region` into the endpoint host,
            // and this row is never re-parsed against `BedrockProviderConfig` on the way out of
            // the database.
            if (!isValidAwsRegion(region)) {
                throw new Error(INVALID_AWS_REGION_MESSAGE)
            }
            return createAmazonBedrock({ region, accessKeyId, secretAccessKey, fetch: safeHttp.fetch })(modelId)
        }
        case AIProviderName.CLOUDFLARE_GATEWAY: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { accountId, gatewayId } = config as CloudflareGatewayProviderConfig
            const { model: actualModelId } = splitCloudflareGatewayModelId(modelId)
            return createOpenAICompatible({
                name: 'cloudflare',
                fetch: safeHttp.fetch,
                baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`,
                headers: { 'cf-aig-authorization': `Bearer ${apiKey}` },
            }).chatModel(actualModelId)
        }
        case AIProviderName.CUSTOM: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { apiKeyHeader, baseUrl, defaultHeaders } = config as OpenAICompatibleProviderConfig
            return createOpenAICompatible({
                name: 'openai-compatible',
                fetch: safeHttp.fetch,
                baseURL: baseUrl,
                headers: {
                    ...(defaultHeaders ?? {}),
                    [apiKeyHeader]: apiKey,
                },
            }).chatModel(modelId)
        }
        case AIProviderName.MISTRAL:
        case AIProviderName.OPENROUTER: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            return createOpenRouter({ apiKey, fetch: safeHttp.fetch }).chat(modelId) as LanguageModel
        }
        default: {
            const exhaustiveCheck: never = provider
            throw new Error(`Unsupported chat provider: ${exhaustiveCheck}`)
        }
    }
}

/**
 * Strips for ALL providers (not just non-thinking ones) because Anthropic rejects
 * a re-sent `thinking` block whose `signature` didn't survive our DB round-trip /
 * compaction / truncation reshaping ("Invalid `signature` in `thinking` block"),
 * and prior-turn reasoning adds nothing the text + tool results don't already carry.
 * In-flight thinking within one streamText call keeps its intact signature and is
 * untouched — this only touches the cross-turn history we assemble.
 */
function stripThinkingBlocks(messages: ModelMessage[], _provider: AIProviderName): ModelMessage[] {
    const hasThinking = messages.some(
        (msg) => msg.role === 'assistant' && Array.isArray(msg.content)
            && (msg.content as Array<Record<string, unknown>>).some(
                (part) => part['type'] === 'reasoning' || part['type'] === 'thinking',
            ),
    )
    if (!hasThinking) return messages

    return messages
        .map((msg) => {
            if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
            const filtered = (msg.content as Array<Record<string, unknown>>).filter(
                (part) => part['type'] !== 'reasoning' && part['type'] !== 'thinking',
            )
            if (filtered.length === msg.content.length) return msg
            if (filtered.length === 0) return null
            return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== null)
}

function buildProviderOptions({ provider, tier }: { provider: AIProviderName, tier: { id: string, thinkingBudget: number } }): SharedV3ProviderOptions {
    switch (provider) {
        case AIProviderName.ANTHROPIC:
        case AIProviderName.BEDROCK:
            return { anthropic: { thinking: { type: 'enabled', budgetTokens: tier.thinkingBudget } } }
        case AIProviderName.OPENROUTER:
            return { openrouter: { cache_control: { type: 'ephemeral' }, reasoning: { max_tokens: tier.thinkingBudget } } }
        default:
            return {}
    }
}

function buildSystemPromptWithCaching({ systemPrompt, provider }: { systemPrompt: string, provider: AIProviderName }): string | SystemModelMessage {
    switch (provider) {
        case AIProviderName.ANTHROPIC:
        case AIProviderName.BEDROCK:
            return { role: 'system', content: systemPrompt, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
        default:
            return systemPrompt
    }
}

function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function extractBatchProgress(rawOutput: unknown): BatchProgressData | undefined {
    const outputRecord = toRecord(rawOutput)
    const { batchProgress } = outputRecord
    return isBatchProgressData(batchProgress) ? batchProgress : undefined
}

type ContentPartLike = {
    type: string
    text?: string
    toolCallId?: string
    toolName?: string
    input?: unknown
    args?: unknown
    output?: unknown
    approvalId?: string
    // The SDK nests the gated call under the approval request rather than repeating its fields
    // flat, so this shape is not interchangeable with the one above.
    toolCall?: {
        toolCallId?: string
        toolName?: string
        input?: unknown
    }
}

function buildStepParts({ content }: {
    content: ContentPartLike[]
}): PersistedChatPart[] {
    const resultMap = new Map<string, ContentPartLike>()
    for (const part of content) {
        if ((part.type === 'tool-result' || part.type === 'tool-error') && part.toolCallId) {
            resultMap.set(part.toolCallId, part)
        }
    }

    // Collected in a pass of its own because the step content lists the gated call *before* its
    // approval request (measured: `['text', 'tool-call', 'tool-approval-request']`), and the SDK
    // enqueues the two from different streams that are merged — so deciding as we walk would depend
    // on an order nothing guarantees.
    const gatedToolCallIds = new Set(content.flatMap((part) => part.type === 'tool-approval-request' && !isNil(part.toolCall?.toolCallId)
        ? [part.toolCall.toolCallId]
        : []))

    const parts: PersistedChatPart[] = []
    for (const part of content) {
        switch (part.type) {
            case 'reasoning':
                if (part.text) parts.push({ type: PersistedChatPartType.REASONING, text: part.text })
                break
            case 'text':
                if (part.text) parts.push({ type: PersistedChatPartType.TEXT, text: part.text })
                break
            case 'tool-approval-request': {
                const gatedCall = part.toolCall
                if (isNil(part.approvalId) || isNil(gatedCall?.toolCallId)) {
                    break
                }
                parts.push({
                    type: PersistedChatPartType.TOOL_APPROVAL_REQUEST,
                    approvalId: part.approvalId,
                    toolCallId: gatedCall.toolCallId,
                    toolName: gatedCall.toolName ?? '',
                    input: toRecord(gatedCall.input),
                })
                break
            }
            case 'tool-call': {
                // A gated call never ran, so it has no result — and a result-less call is recorded
                // below as ERROR, which replays to the model as "the tool failed". It would then
                // apologise or retry instead of waiting for the human the gate exists to ask. The
                // approval request part carries everything needed to describe and to resume it.
                if (!isNil(part.toolCallId) && gatedToolCallIds.has(part.toolCallId)) {
                    break
                }
                const toolName = part.toolName ?? ''
                const input = toRecord(part.args ?? part.input)
                if (toolName === 'ap_update_thinking_status') {
                    const statusText = typeof input['status'] === 'string' ? input['status'] : ''
                    if (statusText) {
                        parts.push({ type: PersistedChatPartType.THINKING_STATUS, text: statusText })
                    }
                    break
                }
                const result = part.toolCallId ? resultMap.get(part.toolCallId) : undefined
                const rawOutput = result?.output ? chatPersistenceUtils.unwrapToolOutput(result.output) : undefined
                const title = typeof input['title'] === 'string' ? input['title'] : undefined
                const description = typeof input['description'] === 'string' ? input['description'] : undefined
                parts.push({
                    type: PersistedChatPartType.TOOL_CALL,
                    toolCallId: part.toolCallId ?? '',
                    toolName,
                    ...spreadIfDefined('title', title),
                    ...spreadIfDefined('description', description),
                    input,
                    output: rawOutput,
                    // A `tool-error` part is a result, so "any result means it worked" recorded
                    // every failed call as COMPLETED. That is the state the next turn's transcript
                    // is rebuilt from, so the model was told a call that threw had succeeded and
                    // returned nothing — it could neither retry nor explain. Absent result and
                    // error result are both failures.
                    status: isNil(result) || result.type === 'tool-error'
                        ? PersistedToolCallStatus.ERROR
                        : PersistedToolCallStatus.COMPLETED,
                })
                const batchProgress = toolName === 'ap_execute_action' ? extractBatchProgress(rawOutput) : undefined
                if (batchProgress) {
                    parts.push({
                        type: PersistedChatPartType.BATCH_PROGRESS,
                        data: batchProgress,
                    })
                }
                if (toolName === 'ap_execute_action' && result) {
                    const outputRecord = typeof rawOutput === 'object' && rawOutput !== null ? rawOutput as Record<string, unknown> : {}
                    const meta = typeof outputRecord['_meta'] === 'object' && outputRecord['_meta'] !== null ? outputRecord['_meta'] as Record<string, unknown> : undefined
                    const connectionLabel = typeof meta?.['connectionLabel'] === 'string' ? meta['connectionLabel'] : undefined
                    const firstContentText = Array.isArray(outputRecord['content']) && typeof outputRecord['content'][0]?.['text'] === 'string' ? outputRecord['content'][0]['text'] as string : ''
                    const isAppSuccess = result.type === 'tool-result'
                        && outputRecord['success'] !== false
                        && outputRecord['isError'] !== true
                        && !firstContentText.startsWith('❌')
                        && !firstContentText.startsWith('⏳')
                        && !firstContentText.includes('cancelled by user')
                    const errorText = !isAppSuccess && firstContentText
                        ? firstContentText
                        : (result.type === 'tool-error' && typeof result.output === 'string' ? result.output : undefined)
                    parts.push({
                        type: PersistedChatPartType.ACTION_RECEIPT,
                        toolCallId: part.toolCallId ?? '',
                        actionDisplayName: title ?? toolName,
                        qadamName: typeof input['qadamName'] === 'string' ? input['qadamName'] : '',
                        ...spreadIfDefined('connectionLabel', connectionLabel),
                        status: isAppSuccess ? 'success' : 'failed',
                        output: rawOutput,
                        ...spreadIfDefined('errorMessage', errorText),
                        timestamp: new Date().toISOString(),
                    })
                }
                break
            }
        }
    }
    return parts
}

export const chatAiUtils = {
    createChatModel,
    stripThinkingBlocks,
    buildProviderOptions,
    buildSystemPromptWithCaching,
    buildStepParts,
}

export type { ContentPartLike }

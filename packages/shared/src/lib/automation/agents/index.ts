import { z } from 'zod'
import { Nullable } from '../../core/common'
import { AIProviderName } from '../../management/ai-providers'
export * from './tools'
export * from './mcp'
export * from './mcp-tool-name-util'

export enum AgentOutputFieldType {
    TEXT = 'text',
    NUMBER = 'number',
    BOOLEAN = 'boolean',
}

export enum AgentTaskStatus {
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    IN_PROGRESS = 'IN_PROGRESS',
}

export enum ContentBlockType {
    MARKDOWN = 'MARKDOWN',
    TOOL_CALL = 'TOOL_CALL',
}

export enum ToolCallStatus {
    IN_PROGRESS = 'in-progress',
    COMPLETED = 'completed',
}

export enum ExecutionToolStatus {
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILED',
}

export enum ToolCallType {
    PIECE = 'PIECE',
    FLOW = 'FLOW',
    MCP = 'MCP',
    KNOWLEDGE_BASE = 'KNOWLEDGE_BASE',
    UNKNOWN = 'UNKNOWN',
}

export const AgentOutputField = z.object({
    displayName: z.string(),
    description: z.string().optional(),
    type: z.nativeEnum(AgentOutputFieldType),
})
export type AgentOutputField = z.infer<typeof AgentOutputField>

export type AgentResult = {
    prompt: string
    steps: AgentStepBlock[]
    status: AgentTaskStatus
    structuredOutput?: unknown
}

export enum AgentQadamProps {
    AGENT_TOOLS = 'agentTools',
    STRUCTURED_OUTPUT = 'structuredOutput',
    PROMPT = 'prompt',
    MAX_STEPS = 'maxSteps',
    AI_PROVIDER_MODEL = 'aiProviderModel',
    WEB_SEARCH = 'webSearch',
    WEB_SEARCH_OPTIONS = 'webSearchOptions',
}

/**
 * `providerId` addresses one AI provider *row*; `provider` names its *type*. Both are kept because
 * they answer different questions and neither replaces the other.
 *
 * A platform may hold several rows of the same type (custom OpenAI-compatible endpoints), so only
 * the id can pick one — the name resolves to the platform's oldest matching row. It is optional and
 * always will be: steps stored before id-addressing carry no id, and a pinned qadam version builds
 * `v1/ai-providers/${provider}/config` from the enum regardless of what is stored.
 *
 * The name cannot be dropped once an id is present either. Capability decisions are made before any
 * config is fetched and are keyed on the enum — which web-search tool builder applies, whether the
 * OpenAI responses API is used, which advancedOptions schema to render, which embedding namespace a
 * provider lives in. None of those can consume a row id.
 */
export type AgentProviderModel = {
    providerId?: string
    provider: AIProviderName
    model: string
}

export const MarkdownContentBlock = z.object({
    type: z.literal(ContentBlockType.MARKDOWN),
    markdown: z.string(),
})
export type MarkdownContentBlock = z.infer<typeof MarkdownContentBlock>

const ToolCallBaseSchema = z.object({
    type: z.literal(ContentBlockType.TOOL_CALL),
    input: Nullable(z.record(z.string(), z.unknown())),
    output: z.unknown().optional(),
    toolName: z.string(),
    status: z.nativeEnum(ToolCallStatus),
    toolCallId: z.string(),
    startTime: z.string(),
    endTime: z.string().optional(),
})
export type ToolCallBase = z.infer<typeof ToolCallBaseSchema>

export const ToolCallContentBlock = z.discriminatedUnion('toolCallType', [
    z.object({
        ...ToolCallBaseSchema.shape,
        toolCallType: z.literal(ToolCallType.PIECE),
        qadamName: z.string(),
        qadamVersion: z.string(),
        actionName: z.string(),
    }),
    z.object({
        ...ToolCallBaseSchema.shape,
        toolCallType: z.literal(ToolCallType.FLOW),
        displayName: z.string(),
        externalFlowId: z.string(),
    }),
    z.object({
        ...ToolCallBaseSchema.shape,
        toolCallType: z.literal(ToolCallType.MCP),
        displayName: z.string(),
        serverUrl: z.string(),
    }),
    z.object({
        ...ToolCallBaseSchema.shape,
        toolCallType: z.literal(ToolCallType.KNOWLEDGE_BASE),
        displayName: z.string(),
        sourceType: z.string(),
    }),
    z.object({
        ...ToolCallBaseSchema.shape,
        toolCallType: z.literal(ToolCallType.UNKNOWN),
        displayName: z.string(),
    }),
])

export type ToolCallContentBlock = z.infer<typeof ToolCallContentBlock>

export const AgentStepBlock = z.union([MarkdownContentBlock, ToolCallContentBlock])
export type AgentStepBlock = z.infer<typeof AgentStepBlock>

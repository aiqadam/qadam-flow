import { ChatContextUsage, isNil } from '@aiqadam/shared'
import { asSchema, LanguageModelUsage, ModelMessage, ToolSet } from 'ai'

export const chatContextUsage = {
    /**
     * What the model's context held when it wrote the reply, for the chat's Context popover.
     *
     * The total is the provider's own count, never an estimate: the last step's input, which already
     * contains every earlier step of the run, plus the text it produced, which the next turn sends
     * back. Reasoning is left out of that addition because `chat-transcript.ts` never replays it —
     * from `textTokens` where the provider splits it out, otherwise by subtracting `reasoningTokens`
     * (OpenRouter reports that but no `textTokens`). A provider that reports neither split —
     * Anthropic among them — counts its reasoning in, which only over-states the figure.
     *
     * Only the split is estimated. No provider says which part of a prompt cost what, so each part is
     * sized by the characters it put on the wire and given that share of the total. Scaling to the
     * real count, rather than dividing characters by four, keeps the parts summing to what the
     * provider reported, and tokenizer differences cancel out of the proportions instead of piling
     * up in the total.
     *
     * Attachments are the one part this cannot size: an image or a PDF is billed per image or page,
     * not per base64 character, so file parts are left out of the split. Their tokens are still in
     * the total, so on a turn with a large attachment the other parts read high.
     *
     * Returns null when the provider did not report input tokens, which some OpenAI-compatible
     * servers do not: a guessed total would be presented as a measurement. Zero counts as not
     * reported too — the openai-compatible SDK turns a `usage` object without `prompt_tokens` into
     * 0, and a real turn always sends at least the system prompt.
     */
    async measure({ modelId, contextWindowTokens, systemPrompt, summary, tools, history, lastStepUsage, transcriptStartIndex }: MeasureParams): Promise<ChatContextUsage | null> {
        const inputTokens = lastStepUsage.inputTokens
        if (isNil(inputTokens) || inputTokens <= 0) {
            return null
        }
        const replyTokens = lastStepUsage.outputTokenDetails.textTokens
            ?? Math.max(0, (lastStepUsage.outputTokens ?? 0) - (lastStepUsage.outputTokenDetails.reasoningTokens ?? 0))
        const usedTokens = inputTokens + replyTokens

        const toolEntries = Object.entries(tools)
        const sizes: PartSizes = {
            systemPrompt: systemPrompt.length,
            summary: summary?.length ?? 0,
            tools: (await Promise.all(toolEntries.map(([name, tool]) => toolDefinitionSize({ name, tool })))).reduce(sum, 0),
            ...historySizes(history),
        }
        const shares = scaleToTotal({ sizes, total: usedTokens })

        return {
            modelId,
            usedTokens,
            contextWindowTokens,
            transcriptStartIndex,
            breakdown: {
                systemPrompt: shares.systemPrompt,
                tools: shares.tools,
                toolCount: toolEntries.length,
                messages: shares.messages,
                toolOutputs: shares.toolOutputs,
                summary: shares.summary,
            },
        }
    },
}

// What the SDK serialises for one tool: its name, its description and the JSON schema of its input.
async function toolDefinitionSize({ name, tool }: { name: string, tool: ToolSet[string] }): Promise<number> {
    const schema = await asSchema(tool.inputSchema).jsonSchema
    return name.length + (tool.description?.length ?? 0) + JSON.stringify(schema).length
}

// Tool results are counted apart from everything else because they are what usually fills a build
// session — a flow's JSON, a qadam's props — and the part the user most needs to see. A tool call's
// input is the model's own writing, so it counts as a message. Reasoning is skipped: it is never
// replayed. File parts are skipped too, for the reason given on `measure`.
function historySizes(history: ModelMessage[]): { messages: number, toolOutputs: number } {
    return history.reduce((totals, message) => {
        const { messages, toolOutputs } = messageSizes(message)
        return { messages: totals.messages + messages, toolOutputs: totals.toolOutputs + toolOutputs }
    }, { messages: 0, toolOutputs: 0 })
}

function messageSizes(message: ModelMessage): { messages: number, toolOutputs: number } {
    if (typeof message.content === 'string') {
        return { messages: message.content.length, toolOutputs: 0 }
    }
    if (message.role === 'tool') {
        return { messages: 0, toolOutputs: message.content.map((part) => JSON.stringify(part.type === 'tool-result' ? part.output : part).length).reduce(sum, 0) }
    }
    const parts: ReadonlyArray<{ type: string }> = message.content
    return {
        messages: parts.map(conversationPartSize).reduce(sum, 0),
        toolOutputs: parts.map(inlineToolResultSize).reduce(sum, 0),
    }
}

function conversationPartSize(part: { type: string }): number {
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        return part.text.length
    }
    if (part.type === 'tool-call' && 'input' in part) {
        return JSON.stringify(part.input ?? null).length
    }
    return 0
}

// An assistant message can carry a tool result inline when a provider executed the tool itself.
function inlineToolResultSize(part: { type: string }): number {
    return part.type === 'tool-result' && 'output' in part ? JSON.stringify(part.output ?? null).length : 0
}

// Largest-remainder rounding, so the rounded parts still add up to exactly `total`.
function scaleToTotal({ sizes, total }: { sizes: PartSizes, total: number }): PartSizes {
    const entries = PART_KEYS.map((key) => ({ key, size: sizes[key] }))
    const characters = entries.map(({ size }) => size).reduce(sum, 0)
    if (characters === 0) {
        return { systemPrompt: 0, tools: 0, summary: 0, messages: 0, toolOutputs: 0 }
    }
    const floored = entries.map(({ key, size }) => {
        const exact = (size * total) / characters
        return { key, value: Math.floor(exact), remainder: exact - Math.floor(exact) }
    })
    const leftover = total - floored.map(({ value }) => value).reduce(sum, 0)
    const bumped = new Set([...floored].sort((a, b) => b.remainder - a.remainder).slice(0, leftover).map(({ key }) => key))
    const scaled = (key: PartKey): number => {
        const value = floored.find((entry) => entry.key === key)?.value ?? 0
        return bumped.has(key) ? value + 1 : value
    }
    return {
        systemPrompt: scaled('systemPrompt'),
        tools: scaled('tools'),
        summary: scaled('summary'),
        messages: scaled('messages'),
        toolOutputs: scaled('toolOutputs'),
    }
}

function sum(total: number, value: number): number {
    return total + value
}

const PART_KEYS = ['systemPrompt', 'tools', 'summary', 'messages', 'toolOutputs'] as const

type PartKey = typeof PART_KEYS[number]

type PartSizes = Record<PartKey, number>

type MeasureParams = {
    modelId: string
    contextWindowTokens: number | null
    systemPrompt: string
    // The summary sent ahead of the transcript, if one was (#567).
    summary: string | null
    tools: ToolSet
    // Everything the last step was sent, plus the reply it produced: the run's input transcript
    // followed by `response.messages`.
    history: ModelMessage[]
    lastStepUsage: LanguageModelUsage
    transcriptStartIndex: number
}

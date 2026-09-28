import { dynamicTool, LanguageModelUsage, ModelMessage, ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatContextUsage } from '../../../../src/app/chat/chat-context-usage'

const tools: ToolSet = {
    ap_list_flows: dynamicTool({
        description: 'List the flows in the project.',
        inputSchema: z.object({ limit: z.number().describe('How many flows to return.') }),
        execute: async () => ({}),
    }),
}

const history: ModelMessage[] = [
    { role: 'user', content: 'Build me a flow that posts new rows to Slack.' },
    {
        role: 'assistant',
        content: [
            { type: 'reasoning', text: 'x'.repeat(5_000) },
            { type: 'text', text: 'Let me look at your flows.' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'ap_list_flows', input: { limit: 10 } },
        ],
    },
    {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'ap_list_flows', output: { type: 'text', value: 'y'.repeat(4_000) } }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'You have one flow.' }] },
]

function usage({ inputTokens, outputTokens, textTokens, reasoningTokens }: { inputTokens: number | undefined, outputTokens?: number, textTokens?: number, reasoningTokens?: number }): LanguageModelUsage {
    return {
        inputTokens,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens,
        outputTokenDetails: { textTokens, reasoningTokens },
        totalTokens: undefined,
    }
}

async function measure(lastStepUsage: LanguageModelUsage) {
    return chatContextUsage.measure({
        modelId: 'claude-sonnet-4',
        contextWindowTokens: 200_000,
        systemPrompt: 'z'.repeat(2_000),
        tools,
        history,
        lastStepUsage,
    })
}

describe('chatContextUsage.measure', () => {
    it('reports the provider count for the last step plus the reply text it produced', async () => {
        const measured = await measure(usage({ inputTokens: 80_000, outputTokens: 1_500, textTokens: 1_000 }))

        // 1,000 and not 1,500: the reasoning tokens in `outputTokens` are never replayed.
        expect(measured?.usedTokens).toBe(81_000)
        expect(measured?.contextWindowTokens).toBe(200_000)
        expect(measured?.modelId).toBe('claude-sonnet-4')
    })

    it('falls back to the whole output when the provider does not split text from reasoning', async () => {
        const measured = await measure(usage({ inputTokens: 1_000, outputTokens: 200 }))

        expect(measured?.usedTokens).toBe(1_200)
    })

    // OpenRouter reports the reasoning share but no `textTokens`.
    it('subtracts reasoning when the provider reports it without a text count', async () => {
        const measured = await measure(usage({ inputTokens: 1_000, outputTokens: 700, reasoningTokens: 500 }))

        expect(measured?.usedTokens).toBe(1_200)
    })

    it('reads a zero input count as not reported, since every turn sends the system prompt', async () => {
        expect(await measure(usage({ inputTokens: 0, outputTokens: 12 }))).toBeNull()
    })

    it('splits the total so the parts add up to it exactly', async () => {
        const measured = await measure(usage({ inputTokens: 80_001, outputTokens: 999, textTokens: 999 }))
        if (measured === null) throw new Error('expected a measurement')
        const { systemPrompt, tools: toolTokens, messages, toolOutputs } = measured.breakdown

        expect(systemPrompt + toolTokens + messages + toolOutputs).toBe(81_000)
        expect(measured.breakdown.toolCount).toBe(1)
    })

    it('puts tool results apart from the conversation, and leaves reasoning out of both', async () => {
        const measured = await measure(usage({ inputTokens: 10_000, textTokens: 0 }))
        if (measured === null) throw new Error('expected a measurement')

        // The tool result is ~4,000 characters and the conversation well under 200; if the 5,000
        // characters of reasoning were counted, messages would outweigh tool outputs.
        expect(measured.breakdown.toolOutputs).toBeGreaterThan(measured.breakdown.messages * 10)
        // The system prompt (2,000 characters) is about half the tool output.
        expect(measured.breakdown.systemPrompt).toBeGreaterThan(measured.breakdown.toolOutputs * 0.4)
        expect(measured.breakdown.systemPrompt).toBeLessThan(measured.breakdown.toolOutputs * 0.6)
    })

    it('reports nothing rather than a guess when the provider did not count input tokens', async () => {
        expect(await measure(usage({ inputTokens: undefined, outputTokens: 10 }))).toBeNull()
    })
})

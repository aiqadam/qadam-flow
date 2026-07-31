import { AgentQadamProps, AgentToolType } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { mcpUtils } from '../../../../src/app/mcp/tools/mcp-utils'

function flowTool(externalFlowId: string) {
    return { type: AgentToolType.FLOW, toolName: 'weather', externalFlowId }
}

function inputWith(tools: unknown[]) {
    return { prompt: 'hi', [AgentQadamProps.AGENT_TOOLS]: tools }
}

function toolsOf(input: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    return input?.[AgentQadamProps.AGENT_TOOLS] as Array<Record<string, unknown>>
}

describe('mcpUtils.rewriteAgentFlowToolIds', () => {
    it('rewrites a primary-key id into the flow externalId', () => {
        const result = mcpUtils.rewriteAgentFlowToolIds({
            input: inputWith([flowTool('flow-pk-1')]),
            flows: [{ id: 'flow-pk-1', externalId: 'ext-1' }],
        })

        expect(toolsOf(result)[0].externalFlowId).toBe('ext-1')
    })

    it('leaves an externalId untouched', () => {
        const result = mcpUtils.rewriteAgentFlowToolIds({
            input: inputWith([flowTool('ext-1')]),
            flows: [{ id: 'flow-pk-1', externalId: 'ext-1' }],
        })

        expect(toolsOf(result)[0].externalFlowId).toBe('ext-1')
    })

    it('keeps the externalId reading when one flow\'s externalId equals another flow\'s id', () => {
        const result = mcpUtils.rewriteAgentFlowToolIds({
            input: inputWith([flowTool('collide')]),
            flows: [
                { id: 'flow-pk-collides', externalId: 'collide' },
                { id: 'collide', externalId: 'ext-other' },
            ],
        })

        expect(toolsOf(result)[0].externalFlowId).toBe('collide')
    })

    it('leaves an unresolvable reference alone rather than dropping the tool', () => {
        const result = mcpUtils.rewriteAgentFlowToolIds({
            input: inputWith([flowTool('nothing-matches-this')]),
            flows: [{ id: 'flow-pk-1', externalId: 'ext-1' }],
        })

        expect(toolsOf(result)).toHaveLength(1)
        expect(toolsOf(result)[0].externalFlowId).toBe('nothing-matches-this')
    })

    it('preserves non-FLOW tools and other input keys verbatim', () => {
        const pieceTool = { type: AgentToolType.PIECE, toolName: 'send_email' }
        const result = mcpUtils.rewriteAgentFlowToolIds({
            input: inputWith([pieceTool, flowTool('flow-pk-1')]),
            flows: [{ id: 'flow-pk-1', externalId: 'ext-1' }],
        })

        expect(result?.prompt).toBe('hi')
        expect(toolsOf(result)[0]).toEqual(pieceTool)
        expect(toolsOf(result)[1].externalFlowId).toBe('ext-1')
    })

    it('is a no-op for input without agent tools', () => {
        const input = { prompt: 'hi' }
        expect(mcpUtils.rewriteAgentFlowToolIds({ input, flows: [{ id: 'a', externalId: 'b' }] })).toBe(input)
        expect(mcpUtils.rewriteAgentFlowToolIds({ input: undefined, flows: [] })).toBeUndefined()
    })
})

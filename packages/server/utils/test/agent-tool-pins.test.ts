import { MAX_AGENT_TOOL_PINS } from '@aiqadam/shared'
import { agentToolPins } from '../src/agent-tool-pins'

function qadamTool({ toolName, qadamName, qadamVersion }: { toolName: string, qadamName: string, qadamVersion: string }): unknown {
    return { type: 'PIECE', toolName, qadamMetadata: { qadamName, qadamVersion, actionName: 'do_it' } }
}

describe('agentToolPins.fromInput', () => {
    it('reads the pin of every PIECE tool, with its tool name', () => {
        const input = { agentTools: [qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.1' })] }

        expect(agentToolPins.fromInput({ input })).toEqual([{ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.1' }])
    })

    it('keeps a malformed version, for whoever checks the pin', () => {
        const input = { agentTools: [qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: 'latest' })] }

        expect(agentToolPins.fromInput({ input })).toHaveLength(1)
    })

    // #879: the reader is where every consumer bounds a stored array, including one larger than
    // the write path allows (imported or legacy). The scan itself is bounded, not just the result.
    it('reads at most MAX_AGENT_TOOL_PINS entries', () => {
        const input = { agentTools: Array.from({ length: MAX_AGENT_TOOL_PINS + 5 }, (_, index) => qadamTool({ toolName: `t${index}`, qadamName: `@acme/qadam-${index}`, qadamVersion: '1.0.0' })) }

        expect(agentToolPins.fromInput({ input })).toHaveLength(MAX_AGENT_TOOL_PINS)
    })

    it('takes an explicit max for callers that need a smaller bound', () => {
        const input = { agentTools: [qadamTool({ toolName: 'a', qadamName: '@acme/qadam-a', qadamVersion: '1.0.0' }), qadamTool({ toolName: 'b', qadamName: '@acme/qadam-b', qadamVersion: '1.0.0' })] }

        expect(agentToolPins.fromInput({ input, max: 1 })).toHaveLength(1)
    })

    it('skips other tool types, malformed entries and a run-time value', () => {
        expect(agentToolPins.fromInput({ input: { agentTools: [{ type: 'FLOW', toolName: 'f', externalFlowId: 'x' }, { type: 'PIECE', toolName: 'broken' }, 'text', null] } })).toEqual([])
        expect(agentToolPins.fromInput({ input: { agentTools: '{{trigger.tools}}' } })).toEqual([])
        expect(agentToolPins.fromInput({ input: {} })).toEqual([])
    })
})

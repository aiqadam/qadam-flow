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

    it('skips other tool types, malformed entries and a run-time value', () => {
        expect(agentToolPins.fromInput({ input: { agentTools: [{ type: 'FLOW', toolName: 'f', externalFlowId: 'x' }, { type: 'PIECE', toolName: 'broken' }, 'text', null] } })).toEqual([])
        expect(agentToolPins.fromInput({ input: { agentTools: '{{trigger.tools}}' } })).toEqual([])
        expect(agentToolPins.fromInput({ input: {} })).toEqual([])
    })
})

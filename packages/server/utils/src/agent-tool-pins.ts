import { AgentQadamProps, AgentQadamTool, MAX_AGENT_TOOL_PINS } from '@aiqadam/shared'

// The qadams an agent step uses as tools, read from the step's stored `agentTools` input. The
// engine loads each by the tool's own pin (#779), so the worker provisions them and the API
// reports them exactly as it does a step's pin: one reader keeps the two from drifting.
//
// `agentTools` is a stored array, or a string the engine resolves at run time (a variable
// reference): only the array can be read ahead of the run, and only its PIECE tools name a qadam.
// A malformed entry is skipped here; the pin of a well-formed one is checked by whoever asks.
//
// The scan is bounded to `MAX_AGENT_TOOL_PINS` entries. Every consumer — worker provisioning and
// both MCP reports — goes through this reader, so truncating here is what keeps a stored array
// larger than the cap (an imported or legacy flow) from fanning out one lookup per entry (#879).
export const agentToolPins = {
    fromInput: ({ input, max = MAX_AGENT_TOOL_PINS }: { input: Record<string, unknown>, max?: number }): AgentToolPin[] => {
        const tools = input[AgentQadamProps.AGENT_TOOLS]
        if (!Array.isArray(tools)) {
            return []
        }
        const pins: AgentToolPin[] = []
        for (const tool of tools.slice(0, max)) {
            const parsed = AgentQadamTool.safeParse(tool)
            if (parsed.success) {
                pins.push({ toolName: parsed.data.toolName, qadamName: parsed.data.qadamMetadata.qadamName, qadamVersion: parsed.data.qadamMetadata.qadamVersion })
            }
        }
        return pins
    },
}

export type AgentToolPin = {
    toolName: string
    qadamName: string
    qadamVersion: string
}

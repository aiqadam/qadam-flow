import { AgentQadamProps, AgentQadamTool } from '@aiqadam/shared'

// The qadams an agent step uses as tools, read from the step's stored `agentTools` input. The
// engine loads each by the tool's own pin (#779), so the worker provisions them and the API
// reports them exactly as it does a step's pin: one reader keeps the two from drifting.
//
// `agentTools` is a stored array, or a string the engine resolves at run time (a variable
// reference): only the array can be read ahead of the run, and only its PIECE tools name a qadam.
// A malformed entry is skipped here; the pin of a well-formed one is checked by whoever asks.
export const agentToolPins = {
    fromInput: ({ input }: { input: Record<string, unknown> }): AgentToolPin[] => {
        const tools = input[AgentQadamProps.AGENT_TOOLS]
        if (!Array.isArray(tools)) {
            return []
        }
        return tools.flatMap((tool: unknown) => {
            const parsed = AgentQadamTool.safeParse(tool)
            return parsed.success
                ? [{ toolName: parsed.data.toolName, qadamName: parsed.data.qadamMetadata.qadamName, qadamVersion: parsed.data.qadamMetadata.qadamVersion }]
                : []
        })
    },
}

export type AgentToolPin = {
    toolName: string
    qadamName: string
    qadamVersion: string
}

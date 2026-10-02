import { httpClient } from '@aiqadam/qadams-common'
import { ActionContext } from '@aiqadam/qadams-framework'
import {
  AgentFlowTool,
  AgentToolType,
  McpPropertyType,
  mcpToolNameUtils,
  PopulatedFlow,
  SeekPage,
} from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentOutputBuilder } from '../../src/lib/actions/agents/agent-output-builder'
import { constructAgentTools } from '../../src/lib/actions/agents/tools'
import { agentUtils } from '../../src/lib/actions/agents/utils'

// Deliberately different hosts: the bug (#637) was the flow tool dialling the public URL, which a
// worker on an internal-only network cannot reach, so the assertions must be able to tell them apart.
const API_URL = 'http://app.internal:3000/'
const PUBLIC_URL = 'https://public.example.test/api/'

type FlowFixture = {
  id: string
  externalId: string
  description: string
  returnsResponse?: boolean
}

/**
 * Faithful stand-in for `GET /v1/engine/populated-flows`:
 * `externalIds` matches `ff."externalId"` only, `externalIdsOrIds` matches either column.
 * Keeping the two filters distinct is what makes a revert of the fetch widening visible —
 * a `constructFlowsTools` that goes back to `{ externalIds }` stops seeing id-referenced flows.
 */
function fakeFetchFlows(flows: FlowFixture[]) {
  return vi.fn(async (params: { externalIds?: string[], externalIdsOrIds?: string[] }): Promise<SeekPage<PopulatedFlow>> => {
    const byExternalId = new Set(params.externalIds ?? [])
    const byEither = new Set(params.externalIdsOrIds ?? [])
    const matched = flows.filter(
      (flow) =>
        byExternalId.has(flow.externalId) || byEither.has(flow.externalId) || byEither.has(flow.id),
    )
    return { data: matched.map(buildPopulatedFlow), next: null, previous: null }
  })
}

function buildPopulatedFlow(flow: FlowFixture): PopulatedFlow {
  const populated = {
    id: flow.id,
    externalId: flow.externalId,
    projectId: 'project-1',
    version: {
      id: `${flow.id}-version`,
      trigger: {
        settings: {
          qadamName: '@aiqadam/qadam-mcp',
          triggerName: 'mcp_tool',
          input: {
            toolName: 'weather',
            toolDescription: flow.description,
            inputSchema: [{ name: 'city', type: McpPropertyType.TEXT, required: true }],
            returnsResponse: flow.returnsResponse ?? true,
          },
        },
      },
    },
  }
  // The suite only exercises the lookup and the tool shape built from the MCP trigger; building a
  // schema-complete Flow + FlowVersion here would be fixture noise with no extra coverage.
  return populated as unknown as PopulatedFlow
}

function buildFlowTool(externalFlowId: string): AgentFlowTool {
  return {
    type: AgentToolType.FLOW,
    toolName: 'weather',
    externalFlowId,
  }
}

async function construct({ tools, flows }: { tools: AgentFlowTool[], flows: FlowFixture[] }) {
  const fetchFlows = fakeFetchFlows(flows)
  const result = await agentUtils.constructFlowsTools({
    tools,
    fetchFlows,
    apiUrl: API_URL,
    token: 'token',
  })
  return { result, fetchFlows }
}

const TOOL_KEY = mcpToolNameUtils.createToolName('weather')
const TOOL_CALL_OPTIONS = { toolCallId: 'call-1', messages: [] }

describe('agentUtils.constructFlowsTools', () => {
  it('resolves a tool whose externalFlowId holds a flow primary-key id', async () => {
    const { result } = await construct({
      tools: [buildFlowTool('flow-pk-1')],
      flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'BY_ID' }],
    })

    expect(Object.keys(result)).toEqual([TOOL_KEY])
    expect(result[TOOL_KEY].description).toBe('BY_ID')
  })

  it('still resolves a tool whose externalFlowId holds a flow externalId', async () => {
    const { result } = await construct({
      tools: [buildFlowTool('ext-1')],
      flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'BY_EXTERNAL_ID' }],
    })

    expect(Object.keys(result)).toEqual([TOOL_KEY])
    expect(result[TOOL_KEY].description).toBe('BY_EXTERNAL_ID')
  })

  it('prefers the externalId match when one flow\'s externalId equals another flow\'s id', async () => {
    const { result } = await construct({
      tools: [buildFlowTool('collide')],
      flows: [
        { id: 'flow-pk-collides', externalId: 'collide', description: 'EXTERNAL_ID_MATCH' },
        { id: 'collide', externalId: 'ext-other', description: 'ID_MATCH' },
      ],
    })

    expect(result[TOOL_KEY].description).toBe('EXTERNAL_ID_MATCH')
  })

  it('prefers the externalId match regardless of the order the flows come back in', async () => {
    const { result } = await construct({
      tools: [buildFlowTool('collide')],
      flows: [
        { id: 'collide', externalId: 'ext-other', description: 'ID_MATCH' },
        { id: 'flow-pk-collides', externalId: 'collide', description: 'EXTERNAL_ID_MATCH' },
      ],
    })

    expect(result[TOOL_KEY].description).toBe('EXTERNAL_ID_MATCH')
  })

  it('asks the server to match either column', async () => {
    const { fetchFlows } = await construct({
      tools: [buildFlowTool('flow-pk-1')],
      flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'BY_ID' }],
    })

    expect(fetchFlows).toHaveBeenCalledWith({ externalIdsOrIds: ['flow-pk-1'] })
  })

  it('drops an unresolvable tool and warns instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { result } = await construct({
        tools: [buildFlowTool('nothing-matches-this')],
        flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'BY_ID' }],
      })

      expect(result).toEqual({})
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('nothing-matches-this')
    }
    finally {
      warn.mockRestore()
    }
  })
})

describe('agent FLOW tool webhook call', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts to the internal apiUrl sync webhook when the flow returns a response', async () => {
    const sendRequest = stubWebhookResponse()
    const { result } = await construct({
      tools: [buildFlowTool('flow-pk-1')],
      flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'SYNC', returnsResponse: true }],
    })

    await result[TOOL_KEY].execute?.({ city: 'Tashkent' }, TOOL_CALL_OPTIONS)

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0][0]).toMatchObject({
      url: `${API_URL}v1/webhooks/flow-pk-1/sync`,
      body: { city: 'Tashkent' },
    })
  })

  it('posts to the internal apiUrl async webhook when the flow does not return a response', async () => {
    const sendRequest = stubWebhookResponse()
    const { result } = await construct({
      tools: [buildFlowTool('flow-pk-1')],
      flows: [{ id: 'flow-pk-1', externalId: 'ext-1', description: 'ASYNC', returnsResponse: false }],
    })

    await result[TOOL_KEY].execute?.({ city: 'Tashkent' }, TOOL_CALL_OPTIONS)

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0][0]).toMatchObject({ url: `${API_URL}v1/webhooks/flow-pk-1` })
  })

  it('constructAgentTools wires context.server.apiUrl, not publicUrl, into the flow tool', async () => {
    const sendRequest = stubWebhookResponse()
    const fetchFlows = fakeFetchFlows([{ id: 'flow-pk-1', externalId: 'ext-1', description: 'SYNC' }])
    const { tools } = await constructAgentTools({
      outputBuilder: agentOutputBuilder('do the thing'),
      agentTools: [buildFlowTool('flow-pk-1')],
      context: agentToolsContext({ fetchFlows }),
      model: 'stub-model',
    })

    const flowTool = tools[TOOL_KEY]
    expect(flowTool.execute).toBeDefined()
    await flowTool.execute?.({ city: 'Tashkent' }, TOOL_CALL_OPTIONS)

    expect(sendRequest).toHaveBeenCalledTimes(1)
    const { url } = sendRequest.mock.calls[0][0]
    expect(url).toBe(`${API_URL}v1/webhooks/flow-pk-1/sync`)
    expect(url.startsWith(PUBLIC_URL)).toBe(false)
  })
})

function stubWebhookResponse() {
  return vi.spyOn(httpClient, 'sendRequest').mockResolvedValue({
    status: 200,
    headers: {},
    body: { ok: true },
  })
}

function agentToolsContext({ fetchFlows }: { fetchFlows: ReturnType<typeof fakeFetchFlows> }): ActionContext {
  const context = {
    server: { token: 'engine-token', apiUrl: API_URL, publicUrl: PUBLIC_URL },
    flows: { list: fetchFlows },
    agent: { tools: vi.fn(async () => ({})) },
  }
  // constructAgentTools only touches server, flows.list and agent.tools when the agent has no MCP or
  // knowledge-base tools; a full ActionContext would be fixture noise with no extra coverage.
  return context as unknown as ActionContext
}

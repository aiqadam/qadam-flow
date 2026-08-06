import { AgentQadamProps, AIProviderName } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAIModel = vi.fn(async () => ({ modelId: 'stub-model' }))
const createEmbeddingModel = vi.fn(async () => ({
  model: { modelId: 'stub-embedding' },
  embeddingModelId: 'stub-embedding',
  providerOptions: {},
}))

vi.mock('../../src/lib/common/ai-sdk', () => ({
  createAIModel: (...args: unknown[]) => createAIModel(...(args as [])),
  createEmbeddingModel: (...args: unknown[]) => createEmbeddingModel(...(args as [])),
  anthropicSearchTool: vi.fn(),
  openaiSearchTool: vi.fn(),
  googleSearchTool: vi.fn(),
}))

vi.mock('../../src/lib/actions/agents/tools', () => ({
  constructAgentTools: vi.fn(async () => ({ mcpClients: [], tools: {}, toolKeyToAgentTool: {} })),
}))

vi.mock('ai', () => ({
  streamText: vi.fn(() => ({
    fullStream: (async function* () { /* the model is stubbed; no chunks to replay */ })(),
    text: Promise.resolve(''),
  })),
  stepCountIs: vi.fn(),
  hasToolCall: vi.fn(),
}))

import { runAgent } from '../../src/lib/actions/agents/run-agent'

// A real `apId()` — the shape `resolveProviderRef` accepts for a row id.
const ROW_ID = 'kJ3mQ8xL2nP5vB7cR1tZa'

type ProviderModelInput = { providerId?: string, provider: AIProviderName, model: string }

function runAgentContext(aiProviderModel: ProviderModelInput, knowledgeBaseTools: unknown[] = [], webSearch = false) {
  return {
    propsValue: {
      [AgentQadamProps.PROMPT]: 'do the thing',
      [AgentQadamProps.MAX_STEPS]: 3,
      [AgentQadamProps.AI_PROVIDER_MODEL]: aiProviderModel,
      [AgentQadamProps.AGENT_TOOLS]: knowledgeBaseTools,
      [AgentQadamProps.WEB_SEARCH]: webSearch,
    },
    server: { token: 'engine-token', apiUrl: 'https://cloud.example.com/api/' },
    project: { id: 'project-1' },
    flows: { current: { id: 'flow-1' } },
    run: { id: 'run-1' },
    output: { update: vi.fn(async () => undefined) },
  }
}

async function invokeRunAgent(aiProviderModel: ProviderModelInput, knowledgeBaseTools: unknown[] = [], webSearch = false) {
  const context = runAgentContext(aiProviderModel, knowledgeBaseTools, webSearch)
  await (runAgent as unknown as { run: (ctx: unknown) => Promise<unknown> }).run(context)
}

const knowledgeBaseFileTool = [{
  type: 'KNOWLEDGE_BASE',
  toolName: 'search_kb',
  sourceType: 'FILE',
  sourceId: 'file-1',
  sourceName: 'handbook',
}]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('run_agent forwards the provider ref it was configured with', () => {
  it('passes the stored providerId to createAIModel alongside the provider name', async () => {
    await invokeRunAgent({ providerId: ROW_ID, provider: AIProviderName.CUSTOM, model: 'llama-3' })

    expect(createAIModel).toHaveBeenCalledWith(expect.objectContaining({
      providerId: ROW_ID,
      provider: AIProviderName.CUSTOM,
      modelId: 'llama-3',
    }))
  })

  // Knowledge-base file tools take the second resolver, which is reached from a different branch of
  // `run` — forwarding the id to one and not the other would send the embedding call to a different
  // row than the chat call.
  it('passes the stored providerId to createEmbeddingModel too', async () => {
    await invokeRunAgent(
      { providerId: ROW_ID, provider: AIProviderName.OPENAI, model: 'gpt-4.1' },
      knowledgeBaseFileTool,
    )

    expect(createEmbeddingModel).toHaveBeenCalledWith(expect.objectContaining({
      providerId: ROW_ID,
      provider: AIProviderName.OPENAI,
    }))
  })

  // A step stored before id-addressing has no id at all. This is a call-shape pin, not a claim
  // about the ref: `resolveProviderRef` reads an absent key and an explicit `undefined` the same
  // way, so both build `.../ai-providers/openai/config`. What it guards is `spreadIfDefined`, which
  // reads like a needlessly indirect `providerId: agentProviderModel.providerId` and is the only
  // thing keeping `run_agent` from widening every legacy step's call with a key it never stored.
  it('sends no providerId key at all when the step carries none', async () => {
    await invokeRunAgent({ provider: AIProviderName.OPENAI, model: 'gpt-4.1' }, knowledgeBaseFileTool)

    expect(createAIModel.mock.calls[0][0]).not.toHaveProperty('providerId')
    expect(createEmbeddingModel.mock.calls[0][0]).not.toHaveProperty('providerId')
  })
})

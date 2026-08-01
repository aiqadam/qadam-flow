import { httpClient } from '@aiqadam/qadams-common'
import { AIProviderName } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAIModel, createEmbeddingModel } from '../../src/lib/common/ai-sdk'

const API_URL = 'https://cloud.example.com/api/'

type ProviderRow = {
  id: string
  provider: AIProviderName
  config?: Record<string, unknown>
  auth?: Record<string, unknown>
}

// Stands in for `GET /v1/ai-providers/:providerRef/config`. The server resolves `:providerRef` as a
// row id first and falls back to the provider name (#274), so the row it answers with is not
// necessarily the one whose name the step stored — which is the whole point of the id.
function stubProviderConfigRoute(row: ProviderRow) {
  return vi.spyOn(httpClient, 'sendRequest').mockResolvedValue({
    status: 200,
    headers: {},
    body: {
      id: row.id,
      provider: row.provider,
      config: row.config ?? {},
      auth: row.auth ?? { apiKey: 'sk-test' },
      platformId: 'platform-1',
    },
  } as never)
}

function requestedUrl(spy: ReturnType<typeof stubProviderConfigRoute>): string {
  return (spy.mock.calls[0][0] as { url: string }).url
}

function languageModelParams(overrides: Record<string, unknown>) {
  return {
    modelId: 'gpt-4.1',
    provider: AIProviderName.OPENAI,
    engineToken: 'engine-token',
    projectId: 'project-1',
    flowId: 'flow-1',
    runId: 'run-1',
    apiUrl: API_URL,
    ...overrides,
  } as Parameters<typeof createAIModel>[0]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAIModel provider addressing', () => {
  it('addresses the config route by row id when the step carries one', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-second-custom', provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({ providerId: 'row-second-custom' }))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/row-second-custom/config`)
  })

  // The route keeps taking a provider name forever: published qadam versions are pinned exactly and
  // build their URL from the enum, so a step written before id-addressing must keep working.
  it('addresses the config route by provider name when the step carries no id', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-openai', provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({}))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/openai/config`)
  })

  // A ref is a path segment. Everything in `aiProviderModel` comes from step input, so it has to be
  // escaped rather than concatenated straight into the URL the engine token authorises.
  it('escapes the ref instead of letting it add path segments', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-openai', provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({ providerId: '../../flows' }))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/..%2F..%2Fflows/config`)
  })

  // The id decides which row answers, and that row's own type decides which SDK client can talk to
  // it. Building from the name the step stored would hand an OpenAI auth blob to the
  // openai-compatible factory and produce a client pointed at `undefined`.
  it('builds the client from the row the id resolved to, not the name stored in the step', async () => {
    stubProviderConfigRoute({ id: 'row-openai', provider: AIProviderName.OPENAI })

    const model = await createAIModel(languageModelParams({
      providerId: 'row-openai',
      provider: AIProviderName.CUSTOM,
    }))

    expect((model as { provider: string }).provider).toBe('openai.chat')
  })
})

describe('createEmbeddingModel provider addressing', () => {
  it('addresses the config route by row id when one is passed', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-google', provider: AIProviderName.GOOGLE })

    await createEmbeddingModel({
      providerId: 'row-google',
      provider: AIProviderName.GOOGLE,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/row-google/config`)
  })

  it('addresses the config route by provider name when no id is passed', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-google', provider: AIProviderName.GOOGLE })

    await createEmbeddingModel({
      provider: AIProviderName.GOOGLE,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/google/config`)
  })

  // `DEFAULT_EMBEDDING_MODELS` is keyed on the provider name, so reading it with the step's stale
  // name would pick the wrong embedding model — or throw "no default embedding model" for a row
  // that has one.
  it('picks the embedding model of the row the id resolved to', async () => {
    stubProviderConfigRoute({ id: 'row-google', provider: AIProviderName.GOOGLE })

    const result = await createEmbeddingModel({
      providerId: 'row-google',
      provider: AIProviderName.OPENAI,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(result.embeddingModelId).toBe('text-embedding-004')
  })
})

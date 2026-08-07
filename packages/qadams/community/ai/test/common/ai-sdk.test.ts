import { httpClient } from '@aiqadam/qadams-common'
import { AIProviderName } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAIModel, createEmbeddingModel } from '../../src/lib/common/ai-sdk'

const API_URL = 'https://cloud.example.com/api/'
// A real `apId()` — 21 characters from `[0-9A-Za-z]`, which is the shape the server's
// `ProviderRefSchema` accepts and the resolver now checks before building the URL.
const ROW_ID = 'kJ3mQ8xL2nP5vB7cR1tZa'

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
    const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({ providerId: ROW_ID }))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/${ROW_ID}/config`)
  })

  // The route keeps taking a provider name forever: published qadam versions are pinned exactly and
  // build their URL from the enum, so a step written before id-addressing must keep working.
  it('addresses the config route by provider name when the step carries no id', async () => {
    const spy = stubProviderConfigRoute({ id: 'row-openai', provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({}))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/openai/config`)
  })

  // A picker with no selection and an MCP agent filling every advertised key both produce `''`, and
  // `spreadIfDefined` forwards it. `'' ?? provider` is `''`, which builds `.../ai-providers//config`.
  it('falls back to the provider name when the step carries an empty id', async () => {
    const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })

    await createAIModel(languageModelParams({ providerId: '' }))

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/openai/config`)
  })

  // A ref becomes one path segment under the engine token's authority, so it is checked against the
  // shape the server enforces rather than only escaped. `..` is the case escaping does not cover:
  // `.` is unreserved, so `encodeURIComponent` returns it unchanged and the URL parser then
  // collapses `/v1/ai-providers/../config` into `/v1/config`.
  it.each(['..', '../../flows', 'row-second-custom', 'openai '])(
    'refuses to build a URL from the ref %j, which is neither a provider name nor a row id',
    async (providerId) => {
      const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })

      await expect(createAIModel(languageModelParams({ providerId }))).rejects.toThrow(
        'is neither a provider name nor a provider row id',
      )
      expect(spy).not.toHaveBeenCalled()
    },
  )

  // The id decides which row answers, and that row's own type decides which SDK client can talk to
  // it. Building from the name the step stored would hand an OpenAI auth blob to the
  // openai-compatible factory and produce a client pointed at `undefined`.
  it('builds the client from the row the id resolved to, not the name stored in the step', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const model = await createAIModel(languageModelParams({
      providerId: ROW_ID,
      provider: AIProviderName.CUSTOM,
    }))

    expect((model as { provider: string }).provider).toBe('openai.chat')
  })

  // The mismatch above is reachable and only half-honoured: `buildWebSearchConfig` still builds a
  // provider-specific `ToolSet` from the stored name and `run-agent` merges it into the tool set
  // handed to `streamText`. The resulting provider-side failure names nothing, so the log has to.
  it('warns when the answering row disagrees with the name the step stored', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await createAIModel(languageModelParams({ providerId: ROW_ID, provider: AIProviderName.ANTHROPIC }))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('anthropic')
    expect(warn.mock.calls[0][0]).toContain('openai')
  })

  // Each case shadows `provider` with the SDK client it just built, so interpolating that name into
  // the rejection rendered `[object Object]` and told the user nothing.
  it('names the provider in the image-model rejection, not the SDK client object', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.ANTHROPIC })

    await expect(createAIModel(languageModelParams({
      provider: AIProviderName.ANTHROPIC,
      isImage: true,
    }))).rejects.toThrow('Provider anthropic does not support image models')
  })

  it('stays quiet when the answering row is the type the step stored', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await createAIModel(languageModelParams({ providerId: ROW_ID }))

    expect(warn).not.toHaveBeenCalled()
  })

  // `buildWebSearchConfig` builds a provider-specific `ToolSet` from the stored name, and `run-agent`
  // / `ask-ai` merge that tool set into the request they hand to the AI SDK. Warning and continuing
  // there just delays the failure to a point where the SDK error names neither provider — so a
  // caller that is about to attach web-search tools opts into a named failure here instead (#305).
  it('throws a named error instead of warning when a web-search caller requires a provider match', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const rejection: unknown = await createAIModel(languageModelParams({
      providerId: ROW_ID,
      provider: AIProviderName.ANTHROPIC,
      requireProviderMatch: true,
    })).catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain('AI provider mismatch')
    expect((rejection as Error).message).toContain('anthropic')
    expect((rejection as Error).message).toContain('openai')
    expect(warn).not.toHaveBeenCalled()
  })

  // A caller that does not attach web-search tools (e.g. `summarize-text`, `generate-image`) must
  // keep today's warn-and-continue behaviour — the model client itself is fine to build from the
  // row, and there is no name-keyed capability downstream to fail loudly for.
  it('still only warns when requireProviderMatch is not set', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(createAIModel(languageModelParams({
      providerId: ROW_ID,
      provider: AIProviderName.ANTHROPIC,
    }))).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not throw when requireProviderMatch is set but the row matches the stored name', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(createAIModel(languageModelParams({
      providerId: ROW_ID,
      requireProviderMatch: true,
    }))).resolves.toBeDefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createEmbeddingModel provider addressing', () => {
  it('addresses the config route by row id when one is passed', async () => {
    const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.GOOGLE })

    await createEmbeddingModel({
      providerId: ROW_ID,
      provider: AIProviderName.GOOGLE,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/${ROW_ID}/config`)
  })

  it('addresses the config route by provider name when no id is passed', async () => {
    const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.GOOGLE })

    await createEmbeddingModel({
      provider: AIProviderName.GOOGLE,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/google/config`)
  })

  // The second resolver takes the same ref from the same step input, so it needs the same
  // empty-is-absent reading — nothing upstream of it normalises the value.
  it('falls back to the provider name when the step carries an empty id', async () => {
    const spy = stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.GOOGLE })

    await createEmbeddingModel({
      providerId: '',
      provider: AIProviderName.GOOGLE,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(requestedUrl(spy)).toBe(`${API_URL}v1/ai-providers/google/config`)
  })

  // Two independent decisions read the answering row here, and only one of them shows up in
  // `embeddingModelId`. The table lookup picks the model id; the switch under it picks the SDK
  // client. Asserting the id alone leaves the switch free to read the step's stale name, which
  // hands a Google API key to an OpenAI client asking for a Google model id — so pin the client's
  // own identity too, the way the `createAIModel` sibling above does.
  it('builds the embedding client and picks its model from the row the id resolved to', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.GOOGLE })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await createEmbeddingModel({
      providerId: ROW_ID,
      provider: AIProviderName.OPENAI,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })

    expect(result.embeddingModelId).toBe('text-embedding-004')
    expect((result.model as { provider: string }).provider).toBe('google.generative-ai')
  })
})

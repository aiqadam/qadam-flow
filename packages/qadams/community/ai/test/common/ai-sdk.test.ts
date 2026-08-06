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

  // A mismatch used to be honoured: the model client was built from the row the id resolved to
  // while `buildWebSearchConfig` and every other name-keyed capability kept reading the stale
  // `provider` field, so the run's actual model silently diverged from what the UI showed (#298).
  // Building from the name would also hand an OpenAI auth blob to the openai-compatible factory
  // and produce a client pointed at `undefined` — but that path is unreachable now: a mismatch is
  // rejected before any client is built.
  it('rejects instead of building a client when the answering row disagrees with the name the step stored', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(createAIModel(languageModelParams({
      providerId: ROW_ID,
      provider: AIProviderName.CUSTOM,
    }))).rejects.toThrow('AI provider mismatch')

    expect(warn).not.toHaveBeenCalled()
  })

  // Also covers the caller shape #305 briefly gated behind `requireProviderMatch: webSearchEnabled`
  // (`run-agent`/`ask-ai` with web search on): that gate is gone (#298 makes the check unconditional
  // for every caller), so this same mismatch rejects regardless of whether web search is in play.
  it('names both the stored provider and the answering row type in the mismatch error', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      createAIModel(languageModelParams({ providerId: ROW_ID, provider: AIProviderName.ANTHROPIC })),
    ).rejects.toThrow(/anthropic.*openai/)
    expect(warn).not.toHaveBeenCalled()
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

  // No `requireProviderMatch` gate survives here (#305 briefly added one, scoped to web-search
  // callers; #298 makes the check unconditional because every name-keyed capability — not just
  // web search — can silently diverge from the answering row, so there is no caller for whom
  // warn-and-continue is still safe).
  it('stays quiet when the answering row is the type the step stored', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.OPENAI })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await createAIModel(languageModelParams({ providerId: ROW_ID }))

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

  // A mismatch here would have picked the model id from the answering row's type while the switch
  // built the SDK client from whichever provider won the race between the two — reachable, and
  // exactly the divergence #298 closes. Rejected before either decision is made.
  it('rejects instead of building an embedding client when the answering row disagrees with the name the step stored', async () => {
    stubProviderConfigRoute({ id: ROW_ID, provider: AIProviderName.GOOGLE })

    await expect(createEmbeddingModel({
      providerId: ROW_ID,
      provider: AIProviderName.OPENAI,
      engineToken: 'engine-token',
      apiUrl: API_URL,
    })).rejects.toThrow('AI provider mismatch')
  })
})

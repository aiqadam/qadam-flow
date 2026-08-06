import { piecePropertiesUtils } from '@aiqadam/qadams-framework'
import { AIProviderName } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAIModel = vi.fn(async () => ({ modelId: 'stub-model' }))

vi.mock('../../src/lib/common/ai-sdk', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    createAIModel: (...args: unknown[]) => createAIModel(...(args as [])),
  }
})

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    generateText: vi.fn(async () => ({ text: 'billing', sources: [], files: [], response: { body: {} } })),
    generateImage: vi.fn(async () => ({ image: { base64: 'AAAA', uint8Array: new Uint8Array([0]) } })),
    stepCountIs: vi.fn(),
  }
})

import { generateImageAction } from '../../src/lib/actions/image/generate-image'
import { askAI } from '../../src/lib/actions/text/ask-ai'
import { summarizeText } from '../../src/lib/actions/text/summarize-text'
import { classifyText } from '../../src/lib/actions/utility/classify-text'
import { extractStructuredData } from '../../src/lib/actions/utility/extract-structured-data'

// A real `apId()` — the shape `resolveProviderRef` accepts for a row id.
const ROW_ID = 'kJ3mQ8xL2nP5vB7cR1tZa'

type QadamAction = { name: string, props: Record<string, unknown>, run: (context: unknown) => Promise<unknown> }

function asAction(action: unknown): QadamAction {
  return action as unknown as QadamAction
}

function contextFor(propsValue: Record<string, unknown>) {
  return {
    propsValue,
    store: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
    files: { write: vi.fn(async () => 'file-1') },
    server: { token: 'engine-token', apiUrl: 'https://cloud.example.com/api/' },
    project: { id: 'project-1' },
    flows: { current: { id: 'flow-1' } },
    run: { id: 'run-1' },
  }
}

// Only the call into the model resolver is under test. What each action does with the model
// afterwards is its own behaviour and is stubbed off, so a tail that cannot complete against a stub
// must not be read as a failure of the thing being asserted.
async function invoke(action: QadamAction, propsValue: Record<string, unknown>): Promise<void> {
  try {
    await action.run(contextFor(propsValue))
  }
  catch {
    // asserted on the mock below
  }
}

const actions: { label: string, action: QadamAction, propsValue: Record<string, unknown> }[] = [
  {
    label: 'ask-ai',
    action: asAction(askAI),
    propsValue: { prompt: 'why', webSearch: false },
  },
  {
    label: 'summarize-text',
    action: asAction(summarizeText),
    propsValue: { text: 'a long text', prompt: 'summarize' },
  },
  {
    label: 'classify-text',
    action: asAction(classifyText),
    propsValue: { text: 'a support email', categories: ['billing', 'sales'] },
  },
  {
    label: 'extract-structured-data',
    action: asAction(extractStructuredData),
    propsValue: {
      text: 'Jane is 40',
      mode: 'simple',
      schema: { fields: [{ name: 'name', type: 'string', isRequired: true }] },
    },
  },
  {
    label: 'generate-image',
    action: asAction(generateImageAction),
    propsValue: { prompt: 'a cat' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe.each(actions)('$label addresses the provider row its step names', ({ action, propsValue }) => {
  // The whole point of 2d: a step that names a row must reach that row rather than the platform's
  // oldest row of the same type.
  it('forwards the stored providerId to createAIModel', async () => {
    await invoke(action, {
      ...propsValue,
      provider: AIProviderName.OPENAI,
      model: 'gpt-4.1',
      providerId: ROW_ID,
    })

    expect(createAIModel).toHaveBeenCalledWith(expect.objectContaining({
      providerId: ROW_ID,
      provider: AIProviderName.OPENAI,
      modelId: 'gpt-4.1',
    }))
  })

  // A step saved before this prop existed carries no id at all. `spreadIfDefined` is what keeps the
  // call from widening with a key the step never stored — an explicit `providerId: undefined` would
  // resolve identically today, so this pins the call shape rather than the ref.
  it('sends no providerId key when the step carries none', async () => {
    await invoke(action, {
      ...propsValue,
      provider: AIProviderName.OPENAI,
      model: 'gpt-4.1',
    })

    expect(createAIModel).toHaveBeenCalledTimes(1)
    expect(createAIModel.mock.calls[0][0]).not.toHaveProperty('providerId')
  })

  // A dropdown with no selection writes `''`, and `spreadIfDefined` forwards it — the same shape
  // `run_agent` produces. Falling back to the provider name from there is `resolveProviderRef`'s
  // job and is pinned in `test/common/ai-sdk.test.ts`; what matters here is that an empty selection
  // never reaches the route as a ref of its own.
  it('forwards an empty selection unchanged, for the resolver to read as absent', async () => {
    await invoke(action, {
      ...propsValue,
      provider: AIProviderName.OPENAI,
      model: 'gpt-4.1',
      providerId: '',
    })

    expect(createAIModel.mock.calls[0][0]).toMatchObject({ providerId: '' })
  })

  it('advertises the optional providerId prop', () => {
    expect(action.props['providerId']).toMatchObject({ required: false })
  })
})

// `flow-version-validator-util.ts` decides a step's `valid` flag by running
// `piecePropertiesUtils.buildSchema` over the action's props and parsing the stored input, and it
// projects in every schema key the stored input does not carry as `undefined`. So "optional" is not
// a label on the prop — it is the difference between an existing step staying valid and every AI
// step in the estate turning invalid the next time it is touched. Asserted against the key rather
// than a whole fixture, so the guard cannot be satisfied or broken by an unrelated prop.
describe.each(actions)('$label validity for a step stored before providerId existed', ({ action }) => {
  const providerIdSchema = () => {
    const schema = piecePropertiesUtils.buildSchema(action.props, undefined, false)
    return (schema as unknown as { shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }> }).shape['providerId']
  }

  it('accepts a stored input that carries no providerId', () => {
    expect(providerIdSchema().safeParse(undefined).success).toBe(true)
  })

  it('accepts a stored input that carries one', () => {
    expect(providerIdSchema().safeParse(ROW_ID).success).toBe(true)
  })
})

// `ask-ai` is the only one of these five actions that can attach a provider-specific web-search
// `ToolSet` built from the stored name. Warning and letting a mismatched row through there just
// delays the failure to a point where the AI SDK error names neither provider, so `ask-ai` opts
// `createAIModel` into failing loudly precisely when that tool set is in play (#305).
describe('ask-ai requires a provider match only when web search is on', () => {
  it('asks createAIModel to fail loudly on a mismatch when web search is enabled', async () => {
    await invoke(asAction(askAI), {
      prompt: 'why',
      webSearch: true,
      provider: AIProviderName.OPENAI,
      model: 'gpt-4.1',
      providerId: ROW_ID,
    })

    expect(createAIModel).toHaveBeenCalledWith(expect.objectContaining({ requireProviderMatch: true }))
  })

  it('leaves createAIModel free to warn-and-continue when web search is off', async () => {
    await invoke(asAction(askAI), {
      prompt: 'why',
      webSearch: false,
      provider: AIProviderName.OPENAI,
      model: 'gpt-4.1',
      providerId: ROW_ID,
    })

    expect(createAIModel).toHaveBeenCalledWith(expect.objectContaining({ requireProviderMatch: false }))
  })
})

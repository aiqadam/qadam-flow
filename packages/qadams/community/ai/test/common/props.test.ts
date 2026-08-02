import { httpClient } from '@aiqadam/qadams-common'
import { AIProviderName } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiProps } from '../../src/lib/common/props'

const API_URL = 'https://cloud.example.com/api/'

// Real `apId()` shapes — 21 characters from `[0-9A-Za-z]`, which is what `resolveProviderRef`
// accepts as a row id and what the server's `ProviderRefSchema` admits.
const OPENAI_ROW = 'aB1cD2eF3gH4iJ5kL6mN7'
const CUSTOM_ROW_OLD = 'kJ3mQ8xL2nP5vB7cR1tZa'
const CUSTOM_ROW_NEW = 'zY9xW8vU7tS6rQ5pO4nM3'

type Row = {
    id: string
    name: string
    provider: AIProviderName
    config?: Record<string, unknown>
}

// `GET /v1/ai-providers` returns one entry per **row**, ordered `created ASC, id ASC` — the same
// order `findProviderOrThrow` uses to pick which row a bare provider *name* resolves to.
function stubListProviders(rows: Row[]) {
    return vi.spyOn(httpClient, 'sendRequest').mockResolvedValue({
        status: 200,
        headers: {},
        body: rows.map((row) => ({
            id: row.id,
            name: row.name,
            provider: row.provider,
            config: row.config ?? {},
            enabledForChat: false,
        })),
    } as never)
}

function stubModelsRoute() {
    return vi.spyOn(httpClient, 'sendRequest').mockResolvedValue({
        status: 200,
        headers: {},
        body: [{ id: 'gpt-4.1', name: 'GPT-4.1', type: 'text' }],
    } as never)
}

const ctx = { server: { apiUrl: API_URL, token: 'engine-token' } }

function optionsOf(property: { options: (propsValue: Record<string, unknown>, context: unknown) => Promise<unknown> }, propsValue: Record<string, unknown> = {}) {
    return property.options(propsValue, ctx) as Promise<{
        disabled?: boolean
        placeholder?: string
        options: { label: string, value: string }[]
    }>
}

const textProps = () => aiProps({ modelType: 'text' })

const twoCustomRows: Row[] = [
    { id: OPENAI_ROW, name: 'OpenAI', provider: AIProviderName.OPENAI },
    { id: CUSTOM_ROW_OLD, name: 'DeepSeek', provider: AIProviderName.CUSTOM, config: { baseUrl: 'https://deep.example/v1', apiKeyHeader: 'Authorization', models: [] } },
    { id: CUSTOM_ROW_NEW, name: 'Groq', provider: AIProviderName.CUSTOM, config: { baseUrl: 'https://groq.example/v1', apiKeyHeader: 'Authorization', models: [] } },
]

afterEach(() => {
    vi.restoreAllMocks()
})

// The `provider` prop keeps emitting the provider *name*, because that is what every stored step
// already holds and what eight capability checks still read. What it must not do is offer two
// entries carrying the same value: `searchable-select` keys options by index so both are clickable,
// resolves the trigger label by value equality so the second renders as the first, and the server
// resolves the name to the oldest row — so choosing the second one silently ran the first.
describe('aiProps().provider', () => {
    it('offers one entry per provider type rather than one per row', async () => {
        stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().provider)

        expect(state.options).toEqual([
            { label: 'OpenAI', value: AIProviderName.OPENAI },
            { label: 'DeepSeek', value: AIProviderName.CUSTOM },
        ])
    })

    // The entry a name addresses is the platform's oldest row of that type, so labelling it with
    // that row's display name is what the choice actually does.
    it('labels a type with the row a bare provider name resolves to', async () => {
        stubListProviders([
            { id: CUSTOM_ROW_OLD, name: 'DeepSeek', provider: AIProviderName.CUSTOM },
            { id: CUSTOM_ROW_NEW, name: 'Groq', provider: AIProviderName.CUSTOM },
        ])

        const state = await optionsOf(textProps().provider)

        expect(state.options).toEqual([{ label: 'DeepSeek', value: AIProviderName.CUSTOM }])
    })

    // A step saved before this change stores a provider name. `searchable-select` matches the stored
    // value against the option values, so that name has to stay among them or the field renders
    // empty on every existing flow.
    it('still offers the value a step saved before this change stored', async () => {
        stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().provider)

        expect(state.options.map((option) => option.value)).toContain('openai')
        expect(state.options.map((option) => option.value)).toContain('custom')
    })

    it('reads the platform rows from the list route under the engine token', async () => {
        const spy = stubListProviders(twoCustomRows)

        await optionsOf(textProps().provider)

        expect(spy.mock.calls[0][0]).toMatchObject({
            url: `${API_URL}v1/ai-providers`,
            headers: { Authorization: 'Bearer engine-token' },
        })
    })
})

describe('aiProps().providerId', () => {
    // Required would mark every step saved before this change invalid on its next read. Absent means
    // "the row the provider name resolves to", which is exactly what those steps do today.
    it('is optional', () => {
        expect(textProps().providerId.required).toBe(false)
    })

    it('offers one entry per row of the selected provider type, valued by row id', async () => {
        stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state.options).toEqual([
            { label: 'DeepSeek (default)', value: CUSTOM_ROW_OLD },
            { label: 'Groq', value: CUSTOM_ROW_NEW },
        ])
    })

    it('leaves out rows of every other provider type', async () => {
        stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.OPENAI })

        expect(state.options).toEqual([{ label: 'OpenAI (default)', value: OPENAI_ROW }])
    })

    // Nothing enforces uniqueness on `displayName`, so the name alone cannot identify a row. The
    // base url is what actually differs between two OpenAI-compatible endpoints and is the value the
    // operator typed — the same disambiguator the builder's model picker uses.
    it('disambiguates rows that share a display name by base url', async () => {
        stubListProviders([
            { id: CUSTOM_ROW_OLD, name: 'AI', provider: AIProviderName.CUSTOM, config: { baseUrl: 'https://a.example/v1', apiKeyHeader: 'Authorization', models: [] } },
            { id: CUSTOM_ROW_NEW, name: 'AI', provider: AIProviderName.CUSTOM, config: { baseUrl: 'https://b.example/v1', apiKeyHeader: 'Authorization', models: [] } },
        ])

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state.options).toEqual([
            { label: 'AI (https://a.example/v1) (default)', value: CUSTOM_ROW_OLD },
            { label: 'AI (https://b.example/v1)', value: CUSTOM_ROW_NEW },
        ])
    })

    // Nothing stops two rows sharing a base url as well as a name — the partial unique index covers
    // neither, and the custom-row cap only counts. The id is the floor because it cannot collide.
    it('falls back to the row id when colliding rows share a base url too', async () => {
        const sameEverything = { baseUrl: 'https://a.example/v1', apiKeyHeader: 'Authorization', models: [] }
        stubListProviders([
            { id: CUSTOM_ROW_OLD, name: 'AI', provider: AIProviderName.CUSTOM, config: sameEverything },
            { id: CUSTOM_ROW_NEW, name: 'AI', provider: AIProviderName.CUSTOM, config: sameEverything },
        ])

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state.options).toEqual([
            { label: `AI (${CUSTOM_ROW_OLD}) (default)`, value: CUSTOM_ROW_OLD },
            { label: `AI (${CUSTOM_ROW_NEW})`, value: CUSTOM_ROW_NEW },
        ])
    })

    // A partial `config` update could blank a custom row's base url before #272 landed, so two rows
    // can collide on the name with no url to tell them apart. The id is ugly but unique.
    it('falls back to the row id when colliding rows carry no base url', async () => {
        stubListProviders([
            { id: CUSTOM_ROW_OLD, name: 'AI', provider: AIProviderName.CUSTOM },
            { id: CUSTOM_ROW_NEW, name: 'AI', provider: AIProviderName.CUSTOM },
        ])

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state.options).toEqual([
            { label: `AI (${CUSTOM_ROW_OLD}) (default)`, value: CUSTOM_ROW_OLD },
            { label: `AI (${CUSTOM_ROW_NEW})`, value: CUSTOM_ROW_NEW },
        ])
    })

    // The builder renders `placeholder` both when the field is unset and when the stored value
    // matches no option, so a placeholder promising a fallback would assert it hardest on a step
    // whose row has been deleted — which is heading for `ENTITY_NOT_FOUND`, not for a fallback.
    // The claim belongs on the row, where it holds unconditionally.
    it('marks the row that answers when nothing is picked, and promises nothing in the placeholder', async () => {
        stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state.placeholder).toBe('Select a provider configuration')
        expect(state.options[0].label).toBe('DeepSeek (default)')
        expect(state.options[1].label).not.toContain('(default)')
    })

    it('is disabled until a provider is chosen', async () => {
        const spy = stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().providerId, {})

        expect(state).toMatchObject({ disabled: true, options: [] })
        expect(spy).not.toHaveBeenCalled()
    })

    // A dropdown with no selection writes `''`, not `undefined`. Without this the empty string
    // reaches the filter, matches no row, and the next line reads `rows[0].name` off nothing.
    it('is disabled when the provider is an empty selection rather than absent', async () => {
        const spy = stubListProviders(twoCustomRows)

        const state = await optionsOf(textProps().providerId, { provider: '' })

        expect(state).toMatchObject({ disabled: true, options: [] })
        expect(spy).not.toHaveBeenCalled()
    })

    // Reachable two ways: the last row of a type is deleted while a step still names it, and a step
    // copied to a platform that configures a different set of providers.
    it('is disabled rather than throwing when the platform holds no row of the chosen type', async () => {
        stubListProviders([{ id: OPENAI_ROW, name: 'OpenAI', provider: AIProviderName.OPENAI }])

        const state = await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(state).toMatchObject({ disabled: true, options: [] })
    })

    it('reads the platform rows from the list route under the engine token', async () => {
        const spy = stubListProviders(twoCustomRows)

        await optionsOf(textProps().providerId, { provider: AIProviderName.CUSTOM })

        expect(spy.mock.calls[0][0]).toMatchObject({
            url: `${API_URL}v1/ai-providers`,
            headers: { Authorization: 'Bearer engine-token' },
        })
    })

    it('refreshes when the provider changes', () => {
        expect(textProps().providerId.refreshers).toEqual(['provider'])
    })
})

describe('aiProps().model', () => {
    it('lists the models of the row the step points at, not of the oldest row of its type', async () => {
        const spy = stubModelsRoute()

        await optionsOf(textProps().model, { provider: AIProviderName.CUSTOM, providerId: CUSTOM_ROW_NEW })

        expect((spy.mock.calls[0][0] as { url: string }).url).toBe(`${API_URL}v1/ai-providers/${CUSTOM_ROW_NEW}/models`)
    })

    it('addresses the models route by provider name when the step carries no row id', async () => {
        const spy = stubModelsRoute()

        await optionsOf(textProps().model, { provider: AIProviderName.OPENAI })

        expect((spy.mock.calls[0][0] as { url: string }).url).toBe(`${API_URL}v1/ai-providers/openai/models`)
    })

    // A dropdown with no selection writes `''`. `'' ?? provider` is `''`, which would build
    // `.../ai-providers//models`.
    it('addresses the models route by provider name when the row id is empty', async () => {
        const spy = stubModelsRoute()

        await optionsOf(textProps().model, { provider: AIProviderName.OPENAI, providerId: '' })

        expect((spy.mock.calls[0][0] as { url: string }).url).toBe(`${API_URL}v1/ai-providers/openai/models`)
    })

    // Without this the field keeps whichever catalogue it fetched for the previous row.
    it('refreshes when either half of the provider reference changes', () => {
        expect(textProps().model.refreshers).toEqual(['provider', 'providerId'])
    })

    it('stays disabled and fetches nothing until a provider is chosen', async () => {
        const spy = stubModelsRoute()

        const state = await optionsOf(textProps().model, {})

        expect(state).toMatchObject({ disabled: true, options: [] })
        expect(spy).not.toHaveBeenCalled()
    })

    // `resolveProviderRef` validates the ref, whichever half it came from. `ai-sdk.test.ts` pins the
    // `providerId` half; the `provider` half is the one that reaches the URL on every legacy step,
    // and it stopped being typed `AIProviderName` when the resolver was widened for this caller.
    // `encodeURIComponent` leaves `.` alone, so `..` would survive escaping and the URL parser then
    // collapses `/v1/ai-providers/../models` to `/v1/models`.
    it.each(['..', '../..', 'openai/../../flows', '%2e%2e', 'openai ', 'nope'])(
        'refuses to build a models URL from the provider %j',
        async (provider) => {
            const spy = stubModelsRoute()

            await expect(optionsOf(textProps().model, { provider })).rejects.toThrow(
                /is neither a provider name nor a provider row id/
            )
            expect(spy).not.toHaveBeenCalled()
        }
    )

    it('refuses a providerId that is neither a name nor a row id', async () => {
        const spy = stubModelsRoute()

        await expect(
            optionsOf(textProps().model, { provider: AIProviderName.OPENAI, providerId: '..' })
        ).rejects.toThrow(/is neither a provider name nor a provider row id/)
        expect(spy).not.toHaveBeenCalled()
    })

    it('filters the catalogue to the model type the action asks for', async () => {
        vi.spyOn(httpClient, 'sendRequest').mockResolvedValue({
            status: 200,
            headers: {},
            body: [
                { id: 'gpt-4.1', name: 'GPT-4.1', type: 'text' },
                { id: 'dall-e-3', name: 'DALL-E 3', type: 'image' },
            ],
        } as never)

        const state = await optionsOf(aiProps({ modelType: 'image' }).model, { provider: AIProviderName.OPENAI })

        expect(state.options).toEqual([{ label: 'DALL-E 3', value: 'dall-e-3' }])
    })
})

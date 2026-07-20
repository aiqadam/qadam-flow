import { FetchError, SeekPage, PopulatedFlow } from '@aiqadam/shared'
import { createFlowsContext } from '../../src/lib/qadam-context/flows'

const CONTEXT_PARAMS = {
    engineToken: 'test-token',
    internalApiUrl: 'http://localhost:3000/',
    flowId: 'flow-123',
    flowVersionId: 'version-456',
}

const emptyPage: SeekPage<PopulatedFlow> = { data: [], next: null, previous: null }

describe('createFlowsContext', () => {

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    describe('list()', () => {
        it('sends repeated query params for multiple externalIds (not comma-joined)', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(emptyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await ctx.list({ externalIds: ['idA', 'idB', 'idC'] })

            const calledUrl = (fetchSpy.mock.calls[0][0] as string).toString()

            // Each ID must appear as its own query parameter
            expect(calledUrl).toContain('externalIds=idA')
            expect(calledUrl).toContain('externalIds=idB')
            expect(calledUrl).toContain('externalIds=idC')

            // Must NOT be joined into a single encoded value like externalIds=idA%2CidB
            expect(calledUrl).not.toContain('%2C')
            expect(calledUrl).not.toMatch(/externalIds=idA[^&]/)
        })

        it('sends a single externalId as a plain query param', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(emptyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await ctx.list({ externalIds: ['onlyId'] })

            const calledUrl = (fetchSpy.mock.calls[0][0] as string).toString()
            expect(calledUrl).toContain('externalIds=onlyId')
        })

        it('sends no externalIds param when the list is empty', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(emptyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await ctx.list({})

            const calledUrl = (fetchSpy.mock.calls[0][0] as string).toString()
            expect(calledUrl).not.toContain('externalIds')
        })

        it('returns the parsed page from the server', async () => {
            const mockFlow = { id: 'flow-1', externalId: 'extA' } as unknown as PopulatedFlow
            const page: SeekPage<PopulatedFlow> = { data: [mockFlow], next: null, previous: null }

            vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            const result = await ctx.list({ externalIds: ['extA'] })

            expect(result.data).toHaveLength(1)
            expect(result.data[0].externalId).toBe('extA')
        })

        it('throws FetchError on non-2xx response', async () => {
            vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }))

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await expect(ctx.list({ externalIds: ['idA'] })).rejects.toThrow(FetchError)
        })
    })

    describe('current', () => {
        it('exposes the current flow id and version id', () => {
            const ctx = createFlowsContext(CONTEXT_PARAMS)
            expect(ctx.current.id).toBe('flow-123')
            expect(ctx.current.version.id).toBe('version-456')
        })
    })
})

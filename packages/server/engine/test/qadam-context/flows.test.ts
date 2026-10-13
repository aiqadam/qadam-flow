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

        it('sends repeated externalIdsOrIds params, distinct from externalIds', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(emptyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await ctx.list({ externalIdsOrIds: ['refA', 'refB'] })

            const calledUrl = (fetchSpy.mock.calls[0][0] as string).toString()
            expect(calledUrl).toContain('externalIdsOrIds=refA')
            expect(calledUrl).toContain('externalIdsOrIds=refB')
            expect(calledUrl).not.toContain('%2C')
            // The narrow filter must not be sent as a side effect of the widened one
            expect(calledUrl).not.toMatch(/[?&]externalIds=/)
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

        it('sends a bounded limit on every request (#577)', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(emptyPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
            )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            await ctx.list({})

            const calledUrl = (fetchSpy.mock.calls[0][0] as string).toString()
            expect(calledUrl).toContain('limit=1000')
        })

        it('walks the cursor and returns every flow as one page (#577)', async () => {
            const flowA = { id: 'flow-a' } as unknown as PopulatedFlow
            const flowB = { id: 'flow-b' } as unknown as PopulatedFlow
            const flowC = { id: 'flow-c' } as unknown as PopulatedFlow
            const firstPage: SeekPage<PopulatedFlow> = { data: [flowA, flowB], next: 'cursor-abc', previous: null }
            const secondPage: SeekPage<PopulatedFlow> = { data: [flowC], next: null, previous: null }

            const fetchSpy = vi.spyOn(global, 'fetch')
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(firstPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
                )
                .mockResolvedValueOnce(
                    new Response(JSON.stringify(secondPage), { status: 200, headers: { 'Content-Type': 'application/json' } }),
                )

            const ctx = createFlowsContext(CONTEXT_PARAMS)
            const result = await ctx.list({})

            expect(fetchSpy).toHaveBeenCalledTimes(2)
            const secondUrl = (fetchSpy.mock.calls[1][0] as string).toString()
            expect(secondUrl).toContain('cursor=cursor-abc')
            expect(secondUrl).toContain('limit=1000')
            expect(result.data.map((flow) => flow.id)).toEqual(['flow-a', 'flow-b', 'flow-c'])
            expect(result.next).toBeNull()
            expect(result.previous).toBeNull()
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

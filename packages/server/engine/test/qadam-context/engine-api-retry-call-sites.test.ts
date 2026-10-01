import { StoreScope } from '@aiqadam/qadams-framework'
import { PauseType } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectionResolver } from '../../src/lib/qadam-context/connection-resolver'
import { createFlowsContext } from '../../src/lib/qadam-context/flows'
import { createContextStore } from '../../src/lib/qadam-context/store'
import { createTranslationResolver } from '../../src/lib/qadam-context/translation-resolver'
import { createVariableResolver } from '../../src/lib/qadam-context/variable-resolver'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { retryingFetch } from '../../src/lib/retrying-fetch'
import { generateMockEngineConstants } from '../handler/test-helper'

// #595: every engine call to the app goes through retryingFetch, and states whether a replay of a
// request that may have landed is safe. These pin that choice per call site.
describe('engine → app calls and their replay safety', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const API = { apiUrl: 'http://app/', engineToken: 'token' }

    it.each([
        ['store.get', true, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).get('k', StoreScope.FLOW)],
        ['store.put', false, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).put('k', 'v', StoreScope.FLOW)],
        ['store.delete', false, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).delete('k', StoreScope.FLOW)],
        ['store.putIfAbsent', false, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).putIfAbsent('k', 'v', StoreScope.FLOW)],
        ['connections.obtain', true, () => createConnectionResolver({ ...API, projectId: 'p1', contextVersion: undefined }).obtain('c1')],
        ['connections.obtainMetadata', true, () => createConnectionResolver({ ...API, projectId: 'p1', contextVersion: undefined }).obtainMetadata('c1')],
        ['variables.obtain', true, () => createVariableResolver({ ...API, projectId: 'p1' }).obtain('v1')],
        ['translations.obtainAll', true, () => createTranslationResolver(API).obtainAll()],
        ['flows.list', true, () => createFlowsContext({ engineToken: 'token', internalApiUrl: 'http://app/', flowId: 'f1', flowVersionId: 'v1' }).list({})],
        ['project', true, () => generateMockEngineConstants().externalProjectId()],
        ['waitpoints.create', true, () => waitpointClient.create({ ...API, flowRunId: 'r1', projectId: 'p1', stepName: 's1', type: PauseType.WEBHOOK, version: 'V1' })],
    ])('%s goes through retryingFetch with idempotent=%s', async (_name, idempotent, call) => {
        const fetchSpy = vi.spyOn(retryingFetch, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))

        await call().catch(() => undefined)

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(fetchSpy.mock.calls[0][0].idempotent).toBe(idempotent)
    })

    it('fails the project read with its HTTP status, rather than taking an error body for the project', async () => {
        vi.spyOn(retryingFetch, 'fetch').mockResolvedValue(new Response(JSON.stringify({ statusCode: 500, message: 'boom' }), { status: 500 }))

        await expect(generateMockEngineConstants().externalProjectId()).rejects.toThrow('HTTP 500')
    })

    it('releases the error body of a failed project read instead of leaving its socket held', async () => {
        const cancel = vi.fn()
        const body = new ReadableStream({ cancel })
        vi.spyOn(retryingFetch, 'fetch').mockResolvedValue(new Response(body, { status: 503 }))

        await expect(generateMockEngineConstants().externalProjectId()).rejects.toThrow('HTTP 503')
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('rejects a project body whose fields are not what the engine reads', async () => {
        vi.spyOn(retryingFetch, 'fetch').mockResolvedValue(new Response(JSON.stringify({ externalId: 42 }), { status: 200 }))

        await expect(generateMockEngineConstants().externalProjectId()).rejects.toThrow('could not be read')
    })

    // A replayed write that had already landed is not the same write taking effect later: a delete
    // replayed after another run's putIfAbsent took the key as its lock would remove that lock.
    it.each([
        ['put', (): Promise<unknown> => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).put('k', 'v', StoreScope.FLOW)],
        ['delete', (): Promise<unknown> => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).delete('k', StoreScope.FLOW)],
    ])('store.%s is not replayed after a failure that may have landed', async (_name, call) => {
        for (const failure of [() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })), () => Promise.resolve(new Response('busy', { status: 503 }))]) {
            const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(failure)
            await expect(call()).rejects.toThrow()
            expect(fetchSpy).toHaveBeenCalledTimes(1)
            vi.restoreAllMocks()
        }
    })

    it.each([
        ['put', (): Promise<unknown> => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).put('k', 'v', StoreScope.FLOW)],
        ['delete', (): Promise<unknown> => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).delete('k', StoreScope.FLOW)],
    ])('store.%s is still retried while the app refuses connections', async (_name, call) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        let refusals = 2
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
            if (refusals > 0) {
                refusals -= 1
                throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
            }
            return new Response(JSON.stringify({}), { status: 200 })
        })

        const outcome = call().then(() => 'ok', (e: unknown) => e)
        await vi.advanceTimersByTimeAsync(10_000)
        vi.useRealTimers()

        expect(await outcome).toBe('ok')
        expect(fetchSpy).toHaveBeenCalledTimes(3)
    })
})

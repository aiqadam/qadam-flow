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

// #595: every engine call to the app goes through retryingFetch, and states whether a replay of a
// request that may have landed is safe. These pin that choice per call site.
describe('engine → app calls and their replay safety', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const API = { apiUrl: 'http://app/', engineToken: 'token' }

    it.each([
        ['store.get', true, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).get('k', StoreScope.FLOW)],
        ['store.put', true, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).put('k', 'v', StoreScope.FLOW)],
        ['store.delete', true, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).delete('k', StoreScope.FLOW)],
        ['store.putIfAbsent', false, () => createContextStore({ ...API, prefix: 'p_', flowId: 'f1' }).putIfAbsent('k', 'v', StoreScope.FLOW)],
        ['connections.obtain', true, () => createConnectionResolver({ ...API, projectId: 'p1', contextVersion: undefined }).obtain('c1')],
        ['connections.obtainMetadata', true, () => createConnectionResolver({ ...API, projectId: 'p1', contextVersion: undefined }).obtainMetadata('c1')],
        ['variables.obtain', true, () => createVariableResolver({ ...API, projectId: 'p1' }).obtain('v1')],
        ['translations.obtainAll', true, () => createTranslationResolver(API).obtainAll()],
        ['flows.list', true, () => createFlowsContext({ engineToken: 'token', internalApiUrl: 'http://app/', flowId: 'f1', flowVersionId: 'v1' }).list({})],
        ['waitpoints.create', true, () => waitpointClient.create({ ...API, flowRunId: 'r1', projectId: 'p1', stepName: 's1', type: PauseType.WEBHOOK, version: 'V1' })],
    ])('%s goes through retryingFetch with idempotent=%s', async (_name, idempotent, call) => {
        const fetchSpy = vi.spyOn(retryingFetch, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))

        await call().catch(() => undefined)

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(fetchSpy.mock.calls[0][0].idempotent).toBe(idempotent)
    })
})

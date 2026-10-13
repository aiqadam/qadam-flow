import { FlowsContext, ListFlowsContextParams } from '@aiqadam/qadams-framework'
import { FetchError, isNil, PopulatedFlow, SeekPage } from '@aiqadam/shared'
import { retryingFetch } from '../retrying-fetch'

// One page stays bounded by the server's MAX_PAGE_SIZE: list() walks the cursor
// instead of asking for every flow at once, so bounding
// GET /v1/engine/populated-flows cannot silently cut a large project off (#577).
const FLOWS_PAGE_SIZE = 1000

export const createFlowsContext = ({ engineToken, internalApiUrl, flowId, flowVersionId }: CreateFlowsServiceParams): FlowsContext => {
    return {
        async list(params: ListFlowsContextParams): Promise<SeekPage<PopulatedFlow>> {
            const data: PopulatedFlow[] = []
            let cursor: string | undefined = undefined
            do {
                const page = await fetchFlowsPage({ engineToken, internalApiUrl, params, cursor })
                data.push(...page.data)
                cursor = isNil(page.next) ? undefined : page.next
            } while (!isNil(cursor))
            return { data, next: null, previous: null }
        },
        current: {
            id: flowId,
            version: {
                id: flowVersionId,
            },
        },
    }
}

async function fetchFlowsPage({ engineToken, internalApiUrl, params, cursor }: FetchFlowsPageParams): Promise<SeekPage<PopulatedFlow>> {
    const queryParams = new URLSearchParams()
    queryParams.set('limit', String(FLOWS_PAGE_SIZE))
    if (!isNil(cursor)) {
        queryParams.set('cursor', cursor)
    }
    if (params?.externalIds) {
        for (const id of params.externalIds) {
            queryParams.append('externalIds', id)
        }
    }
    if (params?.externalIdsOrIds) {
        for (const id of params.externalIdsOrIds) {
            queryParams.append('externalIdsOrIds', id)
        }
    }
    const url = `${internalApiUrl}v1/engine/populated-flows?${queryParams.toString()}`
    const response = await retryingFetch.fetch({
        url,
        init: {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${engineToken}`,
            },
        },
        idempotent: true,
    })
    if (!response.ok) {
        throw new FetchError(url, `status=${response.status}`)
    }
    return response.json() as Promise<SeekPage<PopulatedFlow>>
}

type CreateFlowsServiceParams = {
    engineToken: string
    internalApiUrl: string
    flowId: string
    flowVersionId: string
}

type FetchFlowsPageParams = {
    engineToken: string
    internalApiUrl: string
    params: ListFlowsContextParams | undefined
    cursor: string | undefined
}

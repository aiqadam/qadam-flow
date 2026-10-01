import { FlowsContext, ListFlowsContextParams } from '@aiqadam/qadams-framework'
import { FetchError, PopulatedFlow, SeekPage } from '@aiqadam/shared'
import { retryingFetch } from '../retrying-fetch'

export const createFlowsContext = ({ engineToken, internalApiUrl, flowId, flowVersionId }: CreateFlowsServiceParams): FlowsContext => {
    return {
        async list(params: ListFlowsContextParams): Promise<SeekPage<PopulatedFlow>> {
            const queryParams = new URLSearchParams()
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
        },
        current: {
            id: flowId,
            version: {
                id: flowVersionId,
            },
        },
    }
}

type CreateFlowsServiceParams = {
    engineToken: string
    internalApiUrl: string
    flowId: string
    flowVersionId: string
}

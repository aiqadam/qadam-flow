import { CreateWaitpointRequest, CreateWaitpointResponse, EngineGenericError } from '@aiqadam/shared'
import { retryingFetch } from '../retrying-fetch'

export const waitpointClient = {
    create: async ({ apiUrl, engineToken, ...body }: CreateWaitpointClientRequest): Promise<CreateWaitpointResponse> => {
        // A replay is safe: the app keeps one waitpoint per run and step (`orIgnore` on insert) and
        // answers a second create with the waitpoint the first one made.
        const response = await retryingFetch.fetch({
            url: `${apiUrl}v1/waitpoints`,
            init: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${engineToken}`,
                },
                body: JSON.stringify(body),
            },
            idempotent: true,
        })
        if (!response.ok) {
            throw new EngineGenericError('WaitpointCreationError', `Failed to create waitpoint: ${response.status} ${response.statusText}`)
        }
        return response.json() as Promise<CreateWaitpointResponse>
    },
}

type CreateWaitpointClientRequest = CreateWaitpointRequest & {
    apiUrl: string
    engineToken: string
}

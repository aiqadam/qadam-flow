import { EngineGenericError, ExecutionError, FetchError, VariableNotFoundError } from '@aiqadam/shared'
import { utils } from '../utils'

const HTTP_NOT_FOUND = 404

export const createVariableResolver = ({ projectId: _projectId, engineToken, apiUrl }: CreateVariableResolverParams): VariableResolver => {
    return {
        async obtain(name: string): Promise<string> {
            const url = `${apiUrl}v1/worker/variables/${encodeURIComponent(name)}`

            const { data: value, error: fetchError } = await utils.tryCatchAndThrowOnEngineError((async () => {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${engineToken}`,
                    },
                })

                if (!response.ok) {
                    return handleResponseError({ name, httpStatus: response.status })
                }
                const body = await response.json() as { value: string }
                return body.value
            }))

            if (fetchError) {
                if (fetchError instanceof ExecutionError) {
                    throw fetchError
                }
                throw new FetchError(url, fetchError)
            }
            return value
        },
    }
}

const handleResponseError = ({ name, httpStatus }: { name: string, httpStatus: number }): never => {
    // A 404 is the author naming a variable that does not exist. Reporting it as an ENGINE error
    // failed the whole run with INTERNAL_ERROR and no step list, so nothing said which of the
    // flow's steps held the bad name (#392). Every other status really is an engine-side failure.
    if (httpStatus === HTTP_NOT_FOUND) {
        throw new VariableNotFoundError(name)
    }
    throw new EngineGenericError('VariableResolutionError', `Variable ${name} could not be resolved (HTTP ${httpStatus})`)
}

type VariableResolver = {
    obtain(name: string): Promise<string>
}

type CreateVariableResolverParams = {
    projectId: string
    apiUrl: string
    engineToken: string
}

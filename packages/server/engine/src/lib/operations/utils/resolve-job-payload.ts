import { isNil, JobPayload } from '@aiqadam/shared'
import { engineFileApi } from '../../engine-file-api'
import { RetryPolicy } from '../../retrying-fetch'

export async function resolveJobPayload({ payload, apiUrl, engineToken, retryPolicy }: ResolveJobPayloadParams): Promise<unknown> {
    if (isNil(payload)) {
        return undefined
    }
    if (payload.type === 'inline') {
        return payload.value
    }
    const bytes = await engineFileApi.download({
        fileId: payload.fileId,
        apiUrl,
        engineToken,
        retryPolicy,
    })
    return JSON.parse(new TextDecoder('utf-8').decode(bytes))
}

type ResolveJobPayloadParams = {
    payload: JobPayload | undefined
    apiUrl: string
    engineToken: string
    retryPolicy?: RetryPolicy
}

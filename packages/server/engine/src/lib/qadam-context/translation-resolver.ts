import { EngineGenericError, ExecutionError, FetchError } from '@aiqadam/shared'
import { utils } from '../utils'

export const createTranslationResolver = ({ engineToken, apiUrl }: CreateTranslationResolverParams): TranslationResolver => {
    return {
        async obtainAll(): Promise<TranslationRow[]> {
            const url = `${apiUrl}v1/worker/translations`

            const { data: translations, error: fetchError } = await utils.tryCatchAndThrowOnEngineError((async () => {
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${engineToken}`,
                    },
                })
                if (!response.ok) {
                    throw new EngineGenericError('TranslationFetchError', `Failed to fetch project translations (HTTP ${response.status})`)
                }
                const body = await response.json() as { translations: TranslationRow[] }
                return body.translations
            }))

            if (fetchError) {
                if (fetchError instanceof ExecutionError) {
                    throw fetchError
                }
                throw new FetchError(url, fetchError)
            }
            return translations
        },
    }
}

export type TranslationRow = {
    key: string
    values: Record<string, string>
}

type TranslationResolver = {
    obtainAll(): Promise<TranslationRow[]>
}

type CreateTranslationResolverParams = {
    apiUrl: string
    engineToken: string
}

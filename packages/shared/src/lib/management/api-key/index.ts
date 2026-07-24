import { z } from 'zod'
import { BaseModelSchema } from '../../core/common'
import { ApId } from '../../core/common/id-generator'
import { formErrors } from '../../form-errors'

export const ApiKey = z.object({
    ...BaseModelSchema,
    displayName: z.string(),
    platformId: ApId,
    hashedValue: z.string(),
    truncatedValue: z.string(),
})

export type ApiKey = z.infer<typeof ApiKey>

export const ResponseApiKey = ApiKey.omit({ hashedValue: true })

export type ResponseApiKey = z.infer<typeof ResponseApiKey>

export const ApiKeyResponseWithValue = ResponseApiKey.extend({
    value: z.string(),
})

export type ApiKeyResponseWithValue = z.infer<typeof ApiKeyResponseWithValue>

export const CreateApiKeyRequest = z.object({
    displayName: z.string().min(1, formErrors.required),
})

export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>

export const API_KEY_PREFIX = 'sk-'

export const API_KEY_SECRET_LENGTH = 61

import { z } from 'zod'

export const ListTranslationsRequestQuery = z.object({
    projectId: z.string(),
    cursor: z.string().optional(),
    limit: z.coerce.number().optional(),
    key: z.string().optional(),
    // Keys with no value (or an empty one) for at least one of the project's locales or its
    // default locale. A string, not a boolean: it arrives as a query-string value.
    missing: z.enum(['true', 'false']).optional(),
})
export type ListTranslationsRequestQuery = z.infer<typeof ListTranslationsRequestQuery>

export const ListTranslationLocalesRequestQuery = z.object({
    projectId: z.string(),
})
export type ListTranslationLocalesRequestQuery = z.infer<typeof ListTranslationLocalesRequestQuery>

export const ListTranslationLocalesResponse = z.object({
    locales: z.array(z.string()),
})
export type ListTranslationLocalesResponse = z.infer<typeof ListTranslationLocalesResponse>

export const GetTranslationsForWorkerResponse = z.object({
    translations: z.array(z.object({
        key: z.string(),
        values: z.record(z.string(), z.string()),
    })),
})
export type GetTranslationsForWorkerResponse = z.infer<typeof GetTranslationsForWorkerResponse>

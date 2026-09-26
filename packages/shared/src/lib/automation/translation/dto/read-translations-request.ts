import { z } from 'zod'

export const ListTranslationsRequestQuery = z.object({
    projectId: z.string(),
    cursor: z.string().optional(),
    limit: z.coerce.number().optional(),
    key: z.string().optional(),
})
export type ListTranslationsRequestQuery = z.infer<typeof ListTranslationsRequestQuery>

export const GetTranslationsForWorkerResponse = z.object({
    translations: z.array(z.object({
        key: z.string(),
        values: z.record(z.string(), z.string()),
    })),
})
export type GetTranslationsForWorkerResponse = z.infer<typeof GetTranslationsForWorkerResponse>

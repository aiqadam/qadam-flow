import { z } from 'zod'
import { BaseModelSchema } from '../common/base-model'

export const Tag = z.object({
    ...BaseModelSchema,
    platformId: z.string(),
    name: z.string(),
})

export type Tag = z.infer<typeof Tag>

export const QadamTag = z.object({
    ...BaseModelSchema,
    qadamName: z.string(),
    tagId: z.string(),
    platformId: z.string(),
})

export type QadamTag = z.infer<typeof QadamTag>

export const ListTagsRequest = z.object({
    limit: z.coerce.number().optional(),
    cursor: z.string().optional(),
})

export type ListTagsRequest = z.infer<typeof ListTagsRequest>

export const SetQadamTagsRequest = z.object({
    qadamsName: z.array(z.string()),
    tags: z.array(z.string()),
})

export type SetQadamTagsRequest = z.infer<typeof SetQadamTagsRequest>

export const UpsertTagRequest = z.object({
    name: z.string(),
})

export type UpsertTagRequest = z.infer<typeof UpsertTagRequest>

export const DeleteTagRequest = z.object({
    id: z.string(),
})

export type DeleteTagRequest = z.infer<typeof DeleteTagRequest>

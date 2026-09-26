import { z } from 'zod'
import { BoundedArray, Nullable } from '../../../core/common/base-model'
import { MAX_TRANSLATION_KEYS_PER_UPSERT, TRANSLATION_DESCRIPTION_MAX_LENGTH, TranslationKeySchema, TranslationValues } from '../translation'

export const UpsertTranslationRequestItem = z.object({
    key: TranslationKeySchema,
    values: TranslationValues,
    description: Nullable(z.string().max(TRANSLATION_DESCRIPTION_MAX_LENGTH, 'translationDescriptionTooLong')).optional(),
})
export type UpsertTranslationRequestItem = z.infer<typeof UpsertTranslationRequestItem>

export const UpsertTranslationsRequestBody = z.object({
    projectId: z.string(),
    translations: BoundedArray({ element: UpsertTranslationRequestItem, max: MAX_TRANSLATION_KEYS_PER_UPSERT, nonEmpty: true }),
})
export type UpsertTranslationsRequestBody = z.infer<typeof UpsertTranslationsRequestBody>

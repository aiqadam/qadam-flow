import { z } from 'zod'
import { formErrors } from '../../../form-errors'

export enum TranslationImportFormat {
    FLAT = 'flat',
    NESTED = 'nested',
}

export enum TranslationImportMode {
    MERGE = 'merge',
    REPLACE = 'replace',
}

export const ImportTranslationsRequestBody = z.object({
    projectId: z.string(),
    locale: z.string().min(1, formErrors.required),
    format: z.enum(TranslationImportFormat),
    mode: z.enum(TranslationImportMode),
    // Shape depends on `format` (flat: `{ "a.b": "value" }`; nested: `{ a: { b: "value" } }`) —
    // validated and flattened server-side, where the byte-size cap is also enforced against the
    // raw request body rather than this already-parsed value.
    data: z.record(z.string(), z.unknown()),
})
export type ImportTranslationsRequestBody = z.infer<typeof ImportTranslationsRequestBody>

export const ExportTranslationsRequestQuery = z.object({
    projectId: z.string(),
    locale: z.string().min(1, formErrors.required),
    format: z.enum(TranslationImportFormat).optional(),
})
export type ExportTranslationsRequestQuery = z.infer<typeof ExportTranslationsRequestQuery>

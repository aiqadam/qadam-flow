import { z } from 'zod'

export const TranslationUsage = z.object({
    flowId: z.string(),
    flowDisplayName: z.string(),
    referencedInDraft: z.boolean(),
    referencedInPublished: z.boolean(),
})
export type TranslationUsage = z.infer<typeof TranslationUsage>

export const GetTranslationUsagesResponse = z.object({
    key: z.string(),
    usages: z.array(TranslationUsage),
    scannedFlowCount: z.number(),
    // True once the scan hit MAX_TRANSLATION_USAGE_FLOWS_SCANNED on either the draft or the
    // published pass — the result is a lower bound on actual usage, not the full picture, so a
    // caller (the builder's own "delete this key?" warning) knows to say so rather than implying
    // completeness.
    truncated: z.boolean(),
})
export type GetTranslationUsagesResponse = z.infer<typeof GetTranslationUsagesResponse>

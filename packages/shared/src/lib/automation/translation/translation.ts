import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../core/common/base-model'
import { tryCatchSync } from '../../core/common/try-catch'

export const TRANSLATION_KEY_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$/
export const TRANSLATION_KEY_MAX_LENGTH = 255
export const TRANSLATION_VALUE_MAX_LENGTH = 10_000
export const MAX_TRANSLATION_KEYS_PER_PROJECT = 5_000
// One imported/exported payload is bounded well under Postgres's own per-row jsonb practicalities,
// not at the 1 GB toast ceiling — a single request this size is already pathological for a
// hand- or CI-maintained translation table.
export const MAX_TRANSLATION_IMPORT_BYTES = 1_000_000
export const MAX_LOCALE_TAG_LENGTH = 35
export const MAX_TRANSLATION_KEYS_PER_UPSERT = 500

export const TranslationValues = z.record(z.string(), z.string().max(TRANSLATION_VALUE_MAX_LENGTH, 'translationValueTooLong'))
export type TranslationValues = z.infer<typeof TranslationValues>

export const Translation = z.object({
    ...BaseModelSchema,
    projectId: z.string(),
    platformId: z.string(),
    key: z.string(),
    values: TranslationValues,
    description: Nullable(z.string()),
})
export type Translation = z.infer<typeof Translation>

export const TranslationKeySchema = z.string()
    .min(1, 'formErrors.required')
    .max(TRANSLATION_KEY_MAX_LENGTH, 'translationKeyTooLong')
    .regex(TRANSLATION_KEY_REGEX, 'invalidTranslationKey')

export const localeUtil = {
    /**
     * `Intl.getCanonicalLocales` throws `RangeError` on a malformed BCP-47 tag rather than
     * returning one — every caller here treats "not canonicalizable" as "not a real locale" and
     * falls through, so the throw is caught rather than left to bubble as an engine-level failure.
     */
    canonicalize(raw: string): string | null {
        if (raw.length === 0 || raw.length > MAX_LOCALE_TAG_LENGTH) {
            return null
        }
        const { data, error } = tryCatchSync(() => Intl.getCanonicalLocales(raw))
        if (!error && data.length > 0) {
            return data[0]
        }
        return null
    },
    /** `ru-RU` -> `ru`; `ru` -> null (already a base language, nothing further to try). */
    baseLanguage(canonicalLocale: string): string | null {
        const separatorIndex = canonicalLocale.indexOf('-')
        return separatorIndex === -1 ? null : canonicalLocale.slice(0, separatorIndex)
    },
    /**
     * One resolution chain, used at write-adjacent lookups and at engine resolve time alike:
     * explicit locale (exact, then base language) -> run locale (exact, then base) -> project
     * default locale (exact, then base). Nils are skipped; duplicates are deduped keeping the
     * first (most specific) occurrence, so a chain never tries the same tag twice.
     */
    buildCandidateChain(params: { explicitLocale?: string | null, runLocale?: string | null, defaultLocale?: string | null }): string[] {
        const { explicitLocale, runLocale, defaultLocale } = params
        const ordered = [explicitLocale, runLocale, defaultLocale]
            .flatMap((locale) => {
                if (locale === undefined || locale === null) {
                    return []
                }
                const canonical = localeUtil.canonicalize(locale)
                if (canonical === null) {
                    return []
                }
                const base = localeUtil.baseLanguage(canonical)
                return base === null ? [canonical] : [canonical, base]
            })
        const seen = new Set<string>()
        return ordered.filter((locale) => {
            if (seen.has(locale)) {
                return false
            }
            seen.add(locale)
            return true
        })
    },
    /** First candidate in the chain that has a non-empty value in `values`, or `null`. */
    resolve(params: { values: Record<string, string>, chain: string[] }): { locale: string, value: string } | null {
        const { values, chain } = params
        for (const locale of chain) {
            const value = values[locale]
            if (value !== undefined) {
                return { locale, value }
            }
        }
        return null
    },
}

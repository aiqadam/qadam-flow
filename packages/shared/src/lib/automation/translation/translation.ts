import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../core/common/base-model'
import { tryCatchSync } from '../../core/common/try-catch'

export const TRANSLATION_KEY_REGEX = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_-]+)*$/
export const TRANSLATION_KEY_MAX_LENGTH = 255
export const TRANSLATION_VALUE_MAX_LENGTH = 10_000
export const MAX_TRANSLATION_KEYS_PER_PROJECT = 5_000
// Measures the re-serialized size of the request's already-parsed `data` field
// (`Buffer.byteLength(JSON.stringify(data), 'utf8')` in `translation.controller.ts`), not the
// literal raw HTTP request body — the two differ by whatever whitespace/key-order the client sent
// and the small `locale`/`format`/`mode` fields alongside `data`, but never by more than a few
// bytes for a realistic payload. Bounded well under Postgres's own per-row jsonb practicalities,
// not at the 1 GB toast ceiling — a single request this size is already pathological for a
// hand- or CI-maintained translation table.
export const MAX_TRANSLATION_IMPORT_BYTES = 1_000_000
export const MAX_LOCALE_TAG_LENGTH = 35
export const MAX_TRANSLATION_KEYS_PER_UPSERT = 500
// Well beyond the builder's own four locales (en/ru/uz/kk) to leave headroom for a project
// translating its flows into a realistic global-product locale set (dialects included), while
// still bounding a single row's worst-case jsonb size: 50 locales at the per-value cap above is
// ~500 KB, which is comfortably inside Postgres's per-row practicalities.
export const MAX_TRANSLATION_LOCALES_PER_KEY = 50
// A short translator-facing note ("what is this string for"), not a document — the same order of
// magnitude as other short admin-facing note fields in this codebase.
export const TRANSLATION_DESCRIPTION_MAX_LENGTH = 500
// A whole-project byte cap, checked on every write inside the same transaction (and behind the
// same advisory lock) that enforces `MAX_TRANSLATION_KEYS_PER_PROJECT`, so a build-up of many
// large values cannot slip past the per-key/per-value caps by spreading itself across more keys
// than any single request touches. The original "~1 MB per 5,000 keys" planning figure assumed a
// short (tens-of-bytes) UI string per key/locale pair, which is the common case; a hard cap has to
// bound the worst *legitimate* case instead — a project that pushes many keys toward the
// individual `TRANSLATION_VALUE_MAX_LENGTH` cap across several locales (e.g. long email-template
// bodies) — so 20 MB is chosen deliberately larger than that figure rather than reproducing it.
export const MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT = 20_000_000
// GET /v1/translations/:id/usages scans a project's flows rather than reading a precomputed
// index, so this bounds the request's own cost rather than the table's storage: comfortably
// above what a project management UI needs to show ("used by N flows, showing the first
// MAX_TRANSLATION_USAGE_FLOWS_SCANNED") without ever loading every flow version body a large
// platform project could have. `truncated: true` on the response tells the caller the scan
// stopped short of the project's actual flow count.
export const MAX_TRANSLATION_USAGE_FLOWS_SCANNED = 500

export const TranslationValues = z.record(z.string(), z.string().max(TRANSLATION_VALUE_MAX_LENGTH, 'translationValueTooLong'))
    .refine((values) => Object.keys(values).length <= MAX_TRANSLATION_LOCALES_PER_KEY, 'tooManyTranslationLocales')
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
    /**
     * First candidate in the chain with a value in `values` — a `Map`, never a plain object, so a
     * candidate literally equal to `__proto__` or `constructor` (already rejected by
     * `localeUtil.canonicalize` before it can reach here, but checked again at this boundary for
     * defense in depth) is an ordinary key, never a prototype lookup. Shared by the engine
     * (`props-resolver.ts`) and anywhere else resolving a translation's per-locale value against a
     * candidate chain, so there is exactly one resolution implementation, not two that could drift.
     */
    resolve(params: { values: Map<string, string>, chain: string[] }): { locale: string, value: string } | null {
        const { values, chain } = params
        for (const locale of chain) {
            const value = values.get(locale)
            if (value !== undefined) {
                return { locale, value }
            }
        }
        return null
    },
}

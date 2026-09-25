const TRANSLATION_KEY_BRACKET_PATTERN = /^\[(['"])([^'"]+)\1\]/

// `$t['key']` optionally followed by exactly ONE balanced `[<expr>]` (a dynamic locale) and
// nothing else. Anything past that — a second bracket, a trailing `.field`, an unterminated
// bracket — fails to parse and is treated as an unresolved reference by the caller, the same way
// `parseVariableName`/`parseConnectionNameOnly` do for their own roots.
export function parseTranslationToken(token: string): ParsedTranslationToken | null {
    if (!token.startsWith('$t[')) {
        return null
    }
    const afterRoot = token.slice(2)
    const keyMatch = TRANSLATION_KEY_BRACKET_PATTERN.exec(afterRoot)
    if (keyMatch === null) {
        return null
    }
    const key = keyMatch[2]
    const rest = afterRoot.slice(keyMatch[0].length)
    if (rest.length === 0) {
        return { key, localeExpr: undefined }
    }
    const localeBracket = matchBalancedBracket(rest)
    if (localeBracket === null || localeBracket.length !== rest.length) {
        return null
    }
    return { key, localeExpr: localeBracket.content }
}

// First candidate in the chain with a value in `values` — a `Map`, never a plain object, so a
// candidate literally equal to `__proto__` or `constructor` (rejected by `localeUtil.canonicalize`
// before it can reach here, but checked again at this boundary for defense in depth) is an
// ordinary key, never a prototype lookup.
export function resolveTranslationValue(params: { values: Map<string, string>, chain: string[] }): { locale: string, value: string } | null {
    const { values, chain } = params
    for (const locale of chain) {
        const value = values.get(locale)
        if (value !== undefined) {
            return { locale, value }
        }
    }
    return null
}

// Scans a leading `[...]`, tracking bracket depth and skipping over quoted string contents (so a
// locale expression like `loop['item'].lang`, itself containing `[`/`]`/quotes, is not mistaken
// for the bracket's own end). Returns the matched length (including both brackets) and the text
// between them, or `null` if the leading `[` never closes.
function matchBalancedBracket(text: string): { content: string, length: number } | null {
    if (text[0] !== '[') {
        return null
    }
    let depth = 0
    let i = 0
    while (i < text.length) {
        const ch = text[i]
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch
            i++
            while (i < text.length && text[i] !== quote) {
                i += text[i] === '\\' ? 2 : 1
            }
            i++
            continue
        }
        if (ch === '[') {
            depth++
            i++
            continue
        }
        if (ch === ']') {
            depth--
            i++
            if (depth === 0) {
                return { content: text.slice(1, i - 1), length: i }
            }
            continue
        }
        i++
    }
    return null
}

type ParsedTranslationToken = {
    key: string
    localeExpr: string | undefined
}

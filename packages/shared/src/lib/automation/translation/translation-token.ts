const TRANSLATION_KEY_BRACKET_PATTERN = /^\[(['"])([^'"]+)\1\]/

// `$t['key']` optionally followed by exactly ONE balanced `[<expr>]` (a dynamic locale) and
// nothing else. Anything past that — a second bracket, a trailing `.field`, an unterminated
// bracket — fails to parse and is treated as an unresolved reference by the caller, the same way
// `parseVariableName`/`parseConnectionNameOnly` do for their own roots.
//
// Shared between the engine (`props-resolver.ts`'s `handleTranslation`) and the API's
// `ap_validate_flow` (`validateFlowTranslations`) — one grammar, so a token the engine would
// reject at run time (a trailing `.field`, an unterminated locale bracket) is never reported as a
// valid reference by the validator, and vice versa.
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

export type ParsedTranslationToken = {
    key: string
    localeExpr: string | undefined
}

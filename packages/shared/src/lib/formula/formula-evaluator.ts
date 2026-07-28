import { exceedsSizeBudget, FORMULA_MAX_EXPRESSION_LENGTH, FORMULA_MAX_INPUT_SIZE, FormulaSizeLimitError } from './formula-bounds'
import { evaluateRaw } from './function-implementations'
import { AP_FUNCTIONS } from './function-registry'

// Matches every `{{path}}` occurrence WITHIN ONE SEGMENT's text (never
// across a segment boundary — see exceedsResolvedVariableBudget for why that
// distinction matters). Kept identical to the one used inside
// preprocessExpression/resolveTextVars so this scan and the real resolution
// agree on what counts as a variable reference.
const VARIABLE_TOKEN_REGEX = /\{\{([^}]+)\}\}/g

const CURRENT_FORMULA_VERSION = 1
const FORMULA_PREFIX = `ap-formula-v${CURRENT_FORMULA_VERSION}::{`
const FORMULA_SUFFIX = `}::ap-formula-v${CURRENT_FORMULA_VERSION}`
// Mirrored close marker means tokenization is a plain regex split — no
// brace-counting or string-literal tracking needed at the wrapper level.
// `[\s\S]*?` matches any character including newlines, non-greedy so adjacent
// formulas don't merge into one capture. The `v(\d+)` lets us route saved
// flows from older format versions to the right evaluator after we ship v2,
// without a data migration.
const FORMULA_REGEX = /ap-formula-v(\d+)::\{([\s\S]*?)\}::ap-formula-v\1/g

function wrap(expression: string): string {
    return `${FORMULA_PREFIX}${expression}${FORMULA_SUFFIX}`
}

function containsWrapper(input: string): boolean {
    return /ap-formula-v\d+::\{/.test(input)
}

function unwrap(template: string): string {
    return template.replace(FORMULA_REGEX, (_, _version: string, expr: string) => expr)
}

function evaluate({ expression, sampleData }: EvaluateExpressionParams): EvaluateExpressionResult {
    const trimmed = expression.trim()
    if (!trimmed) return { result: '', error: null }

    const segments = tokenizeFormulaTemplate(trimmed)
    if (segments.length === 0) return { result: '', error: null }

    // Runs once, over every segment the resolver is about to use, before
    // resolving any of them — checked against the SAME segments (not a
    // second tokenizer call, and not the raw/unwrapped template) that
    // resolveTextVars/evaluateSingleFormula below actually read, so this
    // check and the real resolution can never disagree about where one
    // variable reference ends and the next begins. See
    // exceedsResolvedVariableBudget's comment for why scanning the
    // concatenated template — even after unwrapping it — was still wrong.
    if (exceedsResolvedVariableBudget({ segments, sampleData })) {
        return { result: null, error: 'Formula input data is too large to evaluate' }
    }

    if (segments.length === 1 && segments[0].type === 'formula') {
        return evaluateSingleFormula({ expression: segments[0].value, sampleData })
    }

    const parts: string[] = []
    for (const seg of segments) {
        if (seg.type === 'text') {
            parts.push(resolveTextVars(seg.value, sampleData))
            continue
        }
        const { result, error } = evaluateSingleFormula({ expression: seg.value, sampleData })
        if (error) return { result: null, error }
        parts.push(result != null ? (typeof result === 'object' ? JSON.stringify(result) : String(result)) : '')
    }
    return { result: parts.join(''), error: null }
}

function tokenizeFormulaTemplate(template: string): Segment[] {
    const segments: Segment[] = []
    let lastIndex = 0
    for (const match of template.matchAll(FORMULA_REGEX)) {
        const start = match.index ?? 0
        if (start > lastIndex) {
            segments.push({ type: 'text', value: template.slice(lastIndex, start) })
        }
        segments.push({ type: 'formula', value: match[2], version: Number(match[1]) })
        lastIndex = start + match[0].length
    }
    if (lastIndex < template.length) {
        segments.push({ type: 'text', value: template.slice(lastIndex) })
    }
    return segments.filter((s) => s.value !== '')
}

// Scans every `{{path}}` occurrence PER SEGMENT — inside what was a formula
// wrapper or sitting in plain text, it doesn't matter, since both eventually
// resolve the same variable into the caller's output — then accumulates all
// of them into ONE combined payload, so `exceedsSizeBudget`'s per-element
// accounting sums the actual cost of concatenating every repetition across
// the whole template. This is a shared TOTAL, not a shared per-segment
// allowance: it does not reset between segments, so spreading a payload
// across many segments still can't dodge it.
//
// Scanning per segment (rather than scanning the concatenated/unwrapped
// template in one regex pass) is not optional. `VARIABLE_TOKEN_REGEX`'s
// `[^}]+` cannot cross a `}` but CAN cross a `{`, so an unbalanced `{{` left
// dangling at the very end of one segment merges with the start of the next
// segment's real `{{token}}` into one bogus capture that resolves to
// undefined and is charged 0 — while the real resolvers below
// (resolveTextVars for text segments, preprocessExpression for formula
// segments) always run their OWN regex pass over one segment's `value` at a
// time and can never see across that boundary. A single global scan and the
// segment-scoped real resolution disagreeing about where one token ends and
// the next begins is exactly how a full-size value hid from the budget:
//   ap-formula-v1::{"{{"}::ap-formula-v1{{step_1.body}}
// tokenizes into a formula segment with value `"{{"` and a text segment
// `{{step_1.body}}`; scanning them SEPARATELY finds no valid token in the
// first (its dangling `{{` matches nothing without a closing `}}` inside the
// same segment) and the real `step_1.body` token intact in the second —
// matching what the real resolvers do. Scanning the concatenation
// `"{{"{{step_1.body}}` instead let `[^}]+` walk straight through the `"` and
// the first segment's trailing `{{`, capturing `"{{__ap_pv0` (garbage,
// charged 0) and eating the real token as part of that one bogus match.
function exceedsResolvedVariableBudget({ segments, sampleData }: { segments: Segment[], sampleData: Record<string, unknown> }): boolean {
    const resolvedValues: unknown[] = []
    for (const seg of segments) {
        for (const match of seg.value.matchAll(VARIABLE_TOKEN_REGEX)) {
            resolvedValues.push(resolveVariable(match[1].trim(), sampleData) ?? null)
        }
    }
    return exceedsSizeBudget({ value: resolvedValues, maxSize: FORMULA_MAX_INPUT_SIZE })
}

function evaluateSingleFormula({ expression, sampleData }: EvaluateExpressionParams): EvaluateExpressionResult {
    const trimmed = expression.trim()
    if (!trimmed) return { result: '', error: null }
    // Checked before any other pass over the string (validateFunctionArgs,
    // preprocessing) so a pathologically large formula fails fast rather than
    // paying for a full parse first. The resolved-var payload itself is
    // already checked once for the whole template by evaluate() before this
    // runs, so it isn't re-checked per segment here.
    if (trimmed.length > FORMULA_MAX_EXPRESSION_LENGTH) {
        return { result: null, error: 'Formula is too large to evaluate — shorten the expression' }
    }
    const emptyArgError = validateFunctionArgs(trimmed)
    if (emptyArgError) return { result: null, error: emptyArgError }

    // preprocessExpression (specifically rewriteLazyIf's defensive fallback
    // for a non-3-arg `if(...)` that somehow reached it despite
    // validateFunctionArgs above) can throw. Inside this try, not before
    // it, so that throw returns the normal {result:null, error} shape
    // instead of escaping uncaught out of evaluate().
    try {
        const { processed, vars } = preprocessExpression({ expression: trimmed, sampleData })
        return { result: evaluateRaw(processed, vars), error: null }
    }
    catch (e) {
        if (e instanceof FormulaSizeLimitError) return { result: null, error: e.message }
        return { result: null, error: friendlyError(e) }
    }
}

function preprocessExpression({ expression, sampleData }: EvaluateExpressionParams): { processed: string, vars: Record<string, unknown> } {
    const vars: Record<string, unknown> = {}
    let idx = 0
    const withVars = expression.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
        const key = `__ap_v${idx++}__`
        const resolved = resolveVariable(path.trim(), sampleData)
        vars[key] = resolved === undefined ? null : resolved
        return key
    })
    const withJsonVars = replaceInlineJsonArrays(withVars, vars, { value: idx })
    return { processed: normalizeExpression(rewriteLazyIf(wrapStringArgs(withJsonVars))), vars }
}

function rewriteLazyIf(expr: string): string {
    const ifOnly = new Set(['if'])
    let result = ''
    let pos = 0
    while (pos < expr.length) {
        const next = findNextFunctionCall(expr, pos, ifOnly)
        if (next === null) {
            result += expr.slice(pos)
            break
        }
        result += expr.slice(pos, next.start)
        const closePos = findMatchingParen(expr, next.openParen)
        if (closePos === -1) {
            result += expr.slice(next.start)
            break
        }
        const argsContent = expr.slice(next.openParen + 1, closePos)
        const args = splitArgsBySemicolon(argsContent).map((a) => rewriteLazyIf(a))
        if (args.length === 3) {
            result += `((${args[0]}) ? (${args[1]}) : (${args[2]}))`
        }
        else {
            // Unreachable for a formula that reached this point:
            // validateFunctionArgs (called before preprocessExpression, on
            // the same argument boundaries) already rejects any `if(...)`
            // that isn't exactly 3-arg, with a message naming the actual
            // problem. This branch existed only to re-emit `if(...)`
            // un-rewritten and let it fall through to expr-eval's built-in
            // `if` — that built-in no longer exists (removed by the
            // allowlist sweep in function-implementations.ts), so this used
            // to be dead code that failed by accident with a message
            // ("undefined variable: if") that named no arity problem.
            // Kept as an explicit, deliberate failure instead of deleting
            // the branch outright, in case `rewriteLazyIf` is ever called on
            // text that bypassed validateFunctionArgs.
            throw new Error(`if() needs exactly 3 values (condition; true value; false value) — got ${args.length}`)
        }
        pos = closePos + 1
    }
    return result
}

function replaceInlineJsonArrays(
    expr: string,
    vars: Record<string, unknown>,
    idxRef: { value: number },
): string {
    let result = ''
    let i = 0
    let inString: '"' | '\'' | null = null

    while (i < expr.length) {
        const ch = expr[i]

        if (inString) {
            if (ch === inString && expr[i - 1] !== '\\') inString = null
            result += ch
            i++
            continue
        }

        if (ch === '"' || ch === '\'') {
            inString = ch
            result += ch
            i++
            continue
        }

        if (ch === '[') {
            let j = i + 1
            while (j < expr.length && (expr[j] === ' ' || expr[j] === '\t')) j++
            if (j < expr.length && expr[j] === '{') {
                const end = findMatchingSquareBracket(expr, i)
                if (end !== -1) {
                    const jsonStr = expr.slice(i, end + 1)
                    try {
                        const parsed = JSON.parse(jsonStr) as unknown
                        if (Array.isArray(parsed)) {
                            const key = `__ap_v${idxRef.value++}__`
                            vars[key] = parsed
                            result += key
                            i = end + 1
                            continue
                        }
                    }
                    catch {
                        // not valid JSON — fall through and include as-is
                    }
                }
            }
        }

        result += ch
        i++
    }

    return result
}

function wrapStringArgs(expr: string): string {
    const fnNames = new Set(AP_FUNCTIONS.map((f) => f.name))
    let result = ''
    let pos = 0

    while (pos < expr.length) {
        const next = findNextFunctionCall(expr, pos, fnNames)

        if (next === null) {
            result += expr.slice(pos)
            break
        }

        result += expr.slice(pos, next.start)

        const fnName = expr.slice(next.start, next.openParen).trim()
        const fn = AP_FUNCTIONS.find((f) => f.name === fnName)
        const closePos = findMatchingParen(expr, next.openParen)

        if (closePos === -1) {
            result += expr.slice(next.start)
            break
        }

        const argsContent = expr.slice(next.openParen + 1, closePos)
        const argParts = splitArgsBySemicolon(argsContent)

        const processedArgs = argParts.map((arg, i) => {
            const inner = wrapStringArgs(arg)
            if (!fn) return inner
            const expectedSpec = fn.argTypes[Math.min(i, fn.argTypes.length - 1)]
            const shouldQuote = expectedSpec === 'string' ||
                (Array.isArray(expectedSpec) && (expectedSpec as string[]).includes('string'))
            return shouldQuote ? quoteIfBare(inner) : inner
        })

        result += fnName + '(' + processedArgs.join(';') + ')'
        pos = closePos + 1
    }

    return result
}

function quoteIfBare(arg: string): string {
    const trimmed = arg.trim()
    if (!trimmed) return arg
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('\'') && trimmed.endsWith('\''))) return arg
    if (trimmed.startsWith('__ap_')) return arg
    const fnCallMatch = trimmed.match(/^([a-z_][a-z0-9_]*)\s*\(/i)
    if (fnCallMatch && AP_FUNCTIONS.some((f) => f.name === fnCallMatch[1])) return arg
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function normalizeExpression(expr: string): string {
    let result = ''
    let inString: '"' | '\'' | null = null
    let i = 0

    while (i < expr.length) {
        const ch = expr[i]

        if (inString) {
            if (ch === inString && (i === 0 || expr[i - 1] !== '\\')) inString = null
            result += ch
            i++
            continue
        }

        if (ch === '"' || ch === '\'') {
            inString = ch
            result += ch
            i++
            continue
        }

        if (ch === ';') {
            result += ','
            i++
            continue
        }

        // Rewrite reserved keyword function calls to aliased names.
        // Only rewrite when the keyword is not preceded by a word character
        // (avoids matching e.g. "understand(" or "anderson(").
        const prevIsWord = i > 0 && /[a-zA-Z0-9_]/.test(expr[i - 1])
        if (!prevIsWord) {
            const rest = expr.slice(i)
            if (rest.startsWith('and('))   {
                result += 'ap_and(';   i += 4; continue
            }
            if (rest.startsWith('or('))    {
                result += 'ap_or(';    i += 3; continue
            }
            if (rest.startsWith('not('))   {
                result += 'ap_not(';   i += 4; continue
            }
            if (rest.startsWith('round(')) {
                result += 'ap_round('; i += 6; continue
            }
        }

        result += ch
        i++
    }

    return result
}

function validateFunctionArgs(expr: string): string | null {
    const fnNames = new Set(AP_FUNCTIONS.map((f) => f.name))
    let pos = 0
    while (pos < expr.length) {
        const next = findNextFunctionCall(expr, pos, fnNames)
        if (!next) break
        const closePos = findMatchingParen(expr, next.openParen)
        // Advance inside the paren so nested calls are also validated
        pos = next.openParen + 1
        if (closePos === -1) continue

        const fnName = expr.slice(next.start, next.openParen).trim()
        const argsContent = expr.slice(next.openParen + 1, closePos)
        const argParts = splitArgsBySemicolon(argsContent)

        // Only flag empties when separators are present — zero-arg calls are fine
        if (argParts.length > 1) {
            for (let i = 0; i < argParts.length; i++) {
                if (!argParts[i].trim()) {
                    return `${fnName}() is missing value ${i + 1} — fill in all values`
                }
            }
        }

        // `if` is documented as exactly 3-arg (AP_FUNCTIONS: `minArgs: 3,
        // maxArgs: 3`) and rewriteLazyIf below only rewrites the 3-arg form
        // into a ternary. A wrong arity here used to fall through to
        // expr-eval's own built-in `if` (a 3-arg eager conditional) and
        // silently return a value for calls the registry already declares
        // invalid; that built-in is now removed by the allowlist sweep in
        // function-implementations.ts, so an un-rewritten `if(...)` would
        // otherwise fail with an incidental "undefined variable: if" that
        // names no arity problem at all. Caught here instead, before
        // rewriteLazyIf ever sees it, with a message that actually says
        // what's wrong.
        const ifArgCount = argsContent.trim() === '' ? 0 : argParts.length
        if (fnName === 'if' && ifArgCount !== 3) {
            return `if() needs exactly 3 values (condition; true value; false value) — got ${ifArgCount}`
        }
    }
    return null
}

function friendlyError(e: unknown): string {
    const msg = String((e as Error).message ?? e)
    // Already a complete, specific, user-facing sentence — thrown by
    // rewriteLazyIf's defensive fallback (see there), which should be
    // unreachable given validateFunctionArgs runs first, but is worded for
    // a human either way rather than relying on this function's generic
    // catch-all below.
    if (/needs exactly 3 values/i.test(msg)) {
        return msg
    }
    if (/division by zero/i.test(msg)) {
        return 'Cannot divide by zero'
    }
    if (/parse error|Expected EOF|unexpected token|value expected|unexpected \)/i.test(msg)) {
        return 'Invalid formula — check for empty values or mismatched parentheses'
    }
    if (/is not defined/i.test(msg)) {
        const m = msg.match(/(\w+) is not defined/)
        return m
            ? `"${m[1]}" is not a known function or variable — check for typos`
            : 'Unknown function or variable — check for typos'
    }
    if (/wrong number of arguments/i.test(msg)) {
        return 'Wrong number of values — check the function reference for the expected inputs'
    }
    if (/not a function/i.test(msg)) {
        return 'That value is not callable as a function'
    }
    return 'Could not evaluate this formula — check all values are filled in correctly'
}

function resolveTextVars(text: string, sampleData: Record<string, unknown>): string {
    return text.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
        const resolved = resolveVariable(path.trim(), sampleData)
        return resolved != null ? String(resolved) : ''
    })
}

function resolveVariable(path: string, sampleData: Record<string, unknown>): unknown {
    const parts = path.split('.')
    let value: unknown = sampleData
    for (const part of parts) {
        if (value == null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[part]
    }
    return value
}

function splitArgsBySemicolon(content: string): string[] {
    const args: string[] = []
    let current = ''
    let depth = 0
    let inString: '"' | '\'' | null = null

    for (let i = 0; i < content.length; i++) {
        const ch = content[i]
        if (inString) {
            if (ch === inString && content[i - 1] !== '\\') inString = null
            current += ch
        }
        else if (ch === '"' || ch === '\'') {
            inString = ch; current += ch
        }
        else if (ch === '(') {
            depth++; current += ch
        }
        else if (ch === ')') {
            depth--; current += ch
        }
        else if (ch === ';' && depth === 0) {
            args.push(current); current = ''
        }
        else {
            current += ch
        }
    }
    args.push(current)
    return args
}

function findNextFunctionCall(
    text: string,
    fromPos: number,
    fnNames: Set<string>,
): { start: number, openParen: number } | null {
    for (let i = fromPos; i < text.length; i++) {
        if (!/[a-z_]/i.test(text[i])) continue
        const wordMatch = text.slice(i).match(/^([a-z_][a-z0-9_]*)\s*\(/i)
        if (wordMatch && fnNames.has(wordMatch[1])) {
            const openParen = i + wordMatch[0].length - 1
            return { start: i, openParen }
        }
    }
    return null
}

function findMatchingParen(text: string, openPos: number): number {
    let depth = 0
    let inString: '"' | '\'' | null = null
    for (let i = openPos; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === inString && (i === 0 || text[i - 1] !== '\\')) inString = null
        }
        else if (ch === '"' || ch === '\'') {
            inString = ch
        }
        else if (ch === '(') {
            depth++
        }
        else if (ch === ')') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

function findMatchingSquareBracket(text: string, openPos: number): number {
    let depth = 0
    let inStr: '"' | '\'' | null = null
    for (let i = openPos; i < text.length; i++) {
        const ch = text[i]
        if (inStr) {
            if (ch === inStr && (i === 0 || text[i - 1] !== '\\')) inStr = null
        }
        else if (ch === '"' || ch === '\'') {
            inStr = ch
        }
        else if (ch === '[') {
            depth++
        }
        else if (ch === ']') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

export const formulaEvaluator = {
    evaluate,
    wrap,
    unwrap,
    containsWrapper,
    PREFIX: FORMULA_PREFIX,
    SUFFIX: FORMULA_SUFFIX,
}

export type EvaluateExpressionParams = {
    expression: string
    sampleData: Record<string, unknown>
}

export type EvaluateExpressionResult = {
    result: unknown
    error: string | null
}

type Segment =
    | { type: 'text', value: string }
    | { type: 'formula', value: string, version: number }

import { ContextVersion } from '@aiqadam/qadams-framework'
import { applyFunctionToValues, extractMustacheTokens, FormulaEvaluationError, formulaEvaluator, isNil, isString, localeUtil, parseTranslationToken, TRANSLATION_KEY_REGEX, TranslationKeyNotFoundError, UnresolvedTemplateReferenceError } from '@aiqadam/shared'

import { initCodeSandbox } from '../core/code/code-sandbox'
import type { EngineConstants } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { createConnectionResolver } from '../qadam-context/connection-resolver'
import { createVariableResolver } from '../qadam-context/variable-resolver'
import { utils } from '../utils'

const CONNECTIONS = 'connections'
const VARIABLES = 'variables'
const TRANSLATIONS = '$t'
// Both quote styles. `{{variables["NAME"]}}` is one character away from the form the unresolved-
// reference error itself recommends, and matching only `'` made that typo resolve to `''`.
// No whitespace tolerance, deliberately: the pattern anchors the quote directly against `[`,
// so `[ 'x' ]` stays unparseable, which means it raises rather than reading a name — the padded
// form is the one users hit when they hand-edit the error's recommended syntax, and failing
// loudly is what tells them which character to remove.
const BRACKET_NAME_PATTERN = /\[(['"])([^'"]+)\1\]/
const FLATTEN_NESTED_KEYS_PATTERN = /\{\{\s*flattenNestedKeys(.*?)\}\}/g
async function replaceTokensAsync(
    str: string,
    replacer: (token: string, inner: string) => Promise<string>,
): Promise<string> {
    const tokens = extractMustacheTokens(str)
    let result = ''
    let lastIndex = 0
    for (const { token, inner, index } of tokens) {
        result += str.slice(lastIndex, index)
        result += await replacer(token, inner)
        lastIndex = index + token.length
    }
    result += str.slice(lastIndex)
    return result
}


export const createPropsResolver = ({ engineToken, projectId, apiUrl, contextVersion, stepNames, constants }: PropsResolverParams) => {
    return {
        resolve: async <T = unknown>(params: ResolveInputParams): Promise<ResolveResult<T>> => {
            const { unresolvedInput, executionState } = params
            if (isNil(unresolvedInput)) {
                return {
                    resolvedInput: unresolvedInput as T,
                    censoredInput: unresolvedInput,
                }
            }
            const referencedStepNames = extractReferencedStepNames(unresolvedInput, stepNames)
            const currentState = await executionState.currentState(Array.from(referencedStepNames))
            const resolveOptions = {
                engineToken,
                projectId,
                apiUrl,
                currentState,
                stepNames,
                constants,
                executionState,
            }
            const resolvedInput = await applyFunctionToValues<T>(
                unresolvedInput,
                (token) => resolveInputAsync({
                    ...resolveOptions,
                    input: token,
                    censoredInput: false,
                    contextVersion,
                }))
            const censoredInput = await applyFunctionToValues<T>(
                unresolvedInput,
                (token) => resolveInputAsync({
                    ...resolveOptions,
                    input: token,
                    censoredInput: true,
                    contextVersion,
                }))
            return {
                resolvedInput,
                censoredInput,
            }
        },
    }
}

const mergeFlattenedKeysArraysIntoOneArray = async (token: string, partsThatNeedResolving: string[],
    resolveOptions: Pick<ResolveInputInternalParams, 'engineToken' | 'projectId' | 'apiUrl' | 'currentState' | 'censoredInput' | 'stepNames' | 'constants' | 'executionState' | 'resolvingLocaleSource'>,
    contextVersion: ContextVersion | undefined,
) => {
    const resolvedValues: Record<string, unknown> = {}
    let longestResultLength = 0
    for (const tokenPart of partsThatNeedResolving) {
        const variableName = tokenPart.substring(2, tokenPart.length - 2)
        resolvedValues[tokenPart] = await resolveSingleToken({
            ...resolveOptions,
            variableName,
            contextVersion,
        })
        if (Array.isArray(resolvedValues[tokenPart])) {
            longestResultLength = Math.max(longestResultLength, resolvedValues[tokenPart].length)
        }
    }
    const result = new Array(longestResultLength).fill(null).map((_, index) => {
        return Object.entries(resolvedValues).reduce((acc, [tokenPart, value]) => {
            const valueToUse = (Array.isArray(value) ? value[index] : value) ?? ''
            acc = acc.replace(tokenPart, isString(valueToUse) ? valueToUse : JSON.stringify(valueToUse))
            return acc
        }, token)
    })
    return result
}

export type PropsResolver = ReturnType<typeof createPropsResolver>

function extractReferencedStepNames(input: unknown, stepNames: string[]): Set<string> {
    const stringifiedInput = JSON.stringify(input)
    const referencedSteps = new Set<string>()
    for (const stepName of stepNames) {
        if (stringifiedInput.includes(stepName)) {
            referencedSteps.add(stepName)
        }
    }
    return referencedSteps
}

/**
 * input: `Hello {{firstName}} {{lastName}}`
 * tokenThatNeedResolving: [`{{firstName}}`, `{{lastName}}`]
 *
 * Exported for `EngineConstants#getRunLocale` — `FlowVersion.localeSource` is a normal
 * mention-capable template field (the Phase 2 builder edits it with the same text input as
 * every other field), so it is resolved through the exact same path as any other input:
 * a single whole-string token (`{{trigger['output'].lang}}`) returns the raw resolved value,
 * and a bare literal (`ru`, no braces) passes through unchanged.
 */
export async function resolveInputAsync(params: ResolveInputInternalParams): Promise<unknown> {
    const { input, currentState, engineToken, projectId, apiUrl, censoredInput, stepNames, constants, executionState, resolvingLocaleSource } = params

    if (formulaEvaluator.containsWrapper(input)) {
        const formulaOptions = { engineToken, projectId, apiUrl, currentState, censoredInput, stepNames, constants, executionState, contextVersion: params.contextVersion, resolvingLocaleSource }
        const { expression: preResolvedExpr, vars: preResolvedVars } = await preResolveFormulaVars({ expression: input, resolveOptions: formulaOptions })
        const { result, error } = formulaEvaluator.evaluate({ expression: preResolvedExpr, sampleData: preResolvedVars })
        if (error) {
            throw new FormulaEvaluationError({ expression: input, message: error })
        }
        return result ?? ''
    }

    const tokensThatNeedResolving = extractMustacheTokens(input)
    const resolveOptions = {
        engineToken,
        projectId,
        apiUrl,
        currentState,
        censoredInput,
        stepNames,
        constants,
        executionState,
        resolvingLocaleSource,
    }
    const inputContainsOnlyOneTokenToResolve =
        tokensThatNeedResolving.length === 1 &&
        tokensThatNeedResolving[0].token === input

    if (inputContainsOnlyOneTokenToResolve) {
        const variableName = tokensThatNeedResolving[0].inner.trim()
        return resolveSingleToken({
            ...resolveOptions,
            variableName,
            contextVersion: params.contextVersion,
        })
    }
    const inputIncludesFlattenNestedKeysTokens = input.match(FLATTEN_NESTED_KEYS_PATTERN)
    if (!isNil(inputIncludesFlattenNestedKeysTokens) && tokensThatNeedResolving.length > 0) {
        return mergeFlattenedKeysArraysIntoOneArray(input, tokensThatNeedResolving.map(t => t.token), resolveOptions, params.contextVersion)
    }

    return replaceTokensAsync(input, async (_fullMatch, variableName) => {
        const result = await resolveSingleToken({
            ...resolveOptions,
            variableName: variableName.trim(),
            contextVersion: params.contextVersion,
        })
        return isString(result) ? result : JSON.stringify(result)
    })
}

async function resolveSingleToken(params: ResolveSingleTokenParams): Promise<unknown> {
    const { variableName, currentState } = params
    if (variableName.startsWith(VARIABLES)) {
        return handleVariable(params)
    }
    if (variableName.startsWith(CONNECTIONS)) {
        return handleConnection(params)
    }
    if (variableName.startsWith(TRANSLATIONS)) {
        return handleTranslation(params)
    }
    return evalInScope({
        js: normalizeInvalidDotKeys(variableName),
        contextAsScope: { ...currentState },
        functions: { flattenNestedKeys },
        unresolvedReference: { expression: variableName, stepNames: params.stepNames },
    })
}

// Rewrites `.<key>` into `['<key>']` when <key> starts with a digit and the dot
// is in a member-access context. Tables `find-records` returns cells keyed by
// auto-generated IDs like `1eS2ijJLdyl7YPvLZLdl9` — writing `.1eS2ij...` is a
// syntax error in JS, so the eval silently returns empty. Rewriting to bracket
// notation makes the natural dot form work while leaving numeric literals
// (`1.5`, `1e10`) untouched by only transforming when the preceding char is a
// letter / `_` / `$` / `]` / `)` — never a digit.
function normalizeInvalidDotKeys(expr: string): string {
    let out = ''
    let i = 0
    while (i < expr.length) {
        const ch = expr[i]
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch
            out += ch
            i++
            while (i < expr.length) {
                if (expr[i] === '\\' && i + 1 < expr.length) {
                    out += expr[i] + expr[i + 1]
                    i += 2
                    continue
                }
                out += expr[i]
                if (expr[i] === quote) {
                    i++
                    break
                }
                i++
            }
            continue
        }
        if (ch === '.' && i + 1 < expr.length && /[0-9]/.test(expr[i + 1])) {
            const prev = out.length > 0 ? out[out.length - 1] : ''
            const isMemberAccessContext = prev === ']' || prev === ')' || /[A-Za-z_$]/.test(prev)
            if (isMemberAccessContext) {
                let j = i + 1
                while (j < expr.length && /[A-Za-z0-9_$]/.test(expr[j])) j++
                const key = expr.slice(i + 1, j)
                out += `['${key}']`
                i = j
                continue
            }
        }
        out += ch
        i++
    }
    return out
}

async function handleVariable(params: ResolveSingleTokenParams): Promise<unknown> {
    const { variableName, engineToken, projectId, apiUrl, censoredInput } = params
    const name = parseVariableName(variableName)
    // Same defect as `{{VAR}}`, one level further in: the expression declares itself a project
    // variable and then names nothing this can read, and returning `''` made it a working HMAC key
    // of the empty string. Nothing below this point can distinguish it from a real value (#392).
    if (isNil(name)) {
        throw new UnresolvedTemplateReferenceError({ expression: variableName })
    }
    if (censoredInput) {
        return '**REDACTED**'
    }
    return createVariableResolver({ engineToken, projectId, apiUrl }).obtain(name)
}

function parseVariableName(variableName: string): string | null {
    if (variableName.startsWith(`${VARIABLES}[`)) {
        const match = variableName.match(BRACKET_NAME_PATTERN)
        return match ? match[2] : null
    }
    if (variableName.startsWith(`${VARIABLES}.`)) {
        return variableName.split('.')[1] ?? null
    }
    return null
}

// `$t['key']` optionally followed by exactly one `[<dynamic locale expression>]`. Values are
// inserted literally and never re-scanned for `{{…}}` — the caller (`resolveInputAsync`) treats
// this function's return value as a leaf, the same as any other resolved token, so a stored value
// containing mustache syntax renders as inert text rather than being interpreted a second time.
// Unlike `variables`/`connections`, a translation value is not a secret: the censored pass resolves
// it the same way the uncensored one does.
async function handleTranslation(params: ResolveSingleTokenParams): Promise<unknown> {
    const { variableName, currentState, stepNames, constants, executionState, resolvingLocaleSource } = params
    const parsed = parseTranslationToken(variableName)
    if (isNil(parsed)) {
        throw new UnresolvedTemplateReferenceError({ expression: variableName })
    }
    const { key, localeExpr } = parsed
    if (!TRANSLATION_KEY_REGEX.test(key)) {
        throw new TranslationKeyNotFoundError({ key })
    }

    const explicitLocale = isNil(localeExpr)
        ? null
        : await resolveExplicitLocale({ localeExpr, currentState, stepNames, variableName })

    // A `$t` reached from INSIDE `localeSource`'s own evaluation (directly, or through a formula
    // wrapper) never calls `constants.getRunLocale` again — that would await the very promise this
    // call is nested inside, which never resolves. Short-circuiting to "no run locale yet" here,
    // scoped to this one call chain via `resolvingLocaleSource`, is what lets every OTHER concurrent
    // `$t` resolution in the same run (a step with several `$t` fields resolved via `Promise.all`, a
    // concurrent loop iteration) await the real, shared `runLocalePromise` instead of also reading
    // null — the previous instance-wide `isResolvingRunLocale` flag on `EngineConstants` could not
    // tell the two cases apart and returned null for both.
    const [translations, runLocale, defaultLocale] = await Promise.all([
        constants.getTranslations(),
        resolvingLocaleSource ? Promise.resolve(null) : constants.getRunLocale({ executionState }),
        constants.getProjectDefaultLocale(),
    ])

    const values = translations.get(key)
    if (isNil(values)) {
        throw new TranslationKeyNotFoundError({ key })
    }

    const chain = localeUtil.buildCandidateChain({ explicitLocale, runLocale, defaultLocale })
    const resolved = localeUtil.resolve({ values, chain })
    if (isNil(resolved)) {
        throw new TranslationKeyNotFoundError({ key })
    }
    if (chain.length > 0 && resolved.locale !== chain[0]) {
        constants.warnTranslationFallbackOnce(`${key}:${chain[0]}`, `translation key "${key}" has no value for locale "${chain[0]}" — falling back to "${resolved.locale}"`)
    }
    return resolved.value
}

// A resolvable-but-broken reference (`nil`/empty/non-string/non-canonical) falls through to the
// run/default locale; an UNRESOLVABLE one (a step name that does not exist in this flow) still
// throws — the plain (non-`failOnUnreadablePath`) mode `evalInScope` already uses for every other
// step reference, via `assertReferenceIsResolvable`. `failOnUnreadablePath` is deliberately NOT set
// here: it would also throw on a merely-undefined property read (e.g. `loop['item'].lang` when
// `lang` was never set), which is exactly the "resolvable... unknown value" case that must fall
// through instead.
async function resolveExplicitLocale(params: { localeExpr: string, currentState: Record<string, unknown>, stepNames: string[], variableName: string }): Promise<string | null> {
    const { localeExpr, currentState, stepNames, variableName } = params
    const evaluated = await evalInScope({
        js: localeExpr,
        contextAsScope: { ...currentState },
        functions: { flattenNestedKeys },
        unresolvedReference: { expression: variableName, stepNames },
    })
    return isString(evaluated) && evaluated.length > 0 ? localeUtil.canonicalize(evaluated) : null
}

async function handleConnection(params: ResolveSingleTokenParams): Promise<unknown> {
    const { variableName, engineToken, projectId, apiUrl, censoredInput } = params
    const connectionName = parseConnectionNameOnly(variableName)
    if (isNil(connectionName)) {
        throw new UnresolvedTemplateReferenceError({ expression: variableName })
    }
    if (censoredInput) {
        return '**REDACTED**'
    }
    const connection = await createConnectionResolver({ engineToken, projectId, apiUrl, contextVersion: params.contextVersion }).obtain(connectionName)
    const pathAfterConnectionName = parsePathAfterConnectionName(variableName, connectionName)
    if (isNil(pathAfterConnectionName) || pathAfterConnectionName.length === 0) {
        return connection
    }
    return evalInScope({
        js: pathAfterConnectionName,
        contextAsScope: { connection },
        functions: { flattenNestedKeys },
        unresolvedReference: { expression: variableName, stepNames: params.stepNames },
        // A sub-path that cannot be read used to resolve to `''` — the same silent-empty-string
        // class as #392, reached through documented syntax like
        // `Authorization: Bearer {{connections['api'].access_token}}`. An unreadable field has no
        // legitimate empty value to fall back to, so it fails the step naming the expression (#437).
        failOnUnreadablePath: true,
    })
}

// The remainder is sliced off the *matched* text, never off a prefix reconstructed by length:
// `parseSquareBracketConnectionPath` matches `['name']` anywhere, including the dotless form the
// builder and the docs emit, so the old `` connections.['name'] `` reconstruction was one
// character longer than the real syntax and handed the bare field name (`host`) to a scope whose
// only binding is `connection`. Bracket form keeps the same `connection` prefix the dot form has.
function parsePathAfterConnectionName(variableName: string, connectionName: string): string | null {
    if (variableName.includes('[')) {
        const match = variableName.match(BRACKET_NAME_PATTERN)
        if (isNil(match) || isNil(match.index)) {
            return null
        }
        const remainder = variableName.substring(match.index + match[0].length)
        return remainder.length === 0 ? remainder : `connection${remainder}`
    }
    const cp = variableName.substring(`connections.${connectionName}`.length)
    if (cp.length === 0) {
        return cp
    }
    return `connection${cp}`
}

function parseConnectionNameOnly(variableName: string): string | null {
    const connectionWithNewFormatSquareBrackets = variableName.includes('[')
    if (connectionWithNewFormatSquareBrackets) {
        return parseSquareBracketConnectionPath(variableName)
    }
    // {{connections.connectionName.path}}
    // This does not work If connectionName contains .
    return variableName.split('.')?.[1]
}

function parseSquareBracketConnectionPath(variableName: string): string | null {
    // Find the connection name inside {{connections['connectionName'].path}}
    // Same both-quote-styles rule as `parseVariableName`. Matching only `'` here would leave
    // `{{connections["x"]}}` unparseable, which now means a raised error rather than the old silent
    // empty string — a worse outcome than simply reading the name, and inconsistent with the
    // message this failure produces, which presents both roots the same way.
    const match = variableName.match(BRACKET_NAME_PATTERN)
    return match ? match[2] : null
}

// `FlowVersion.localeSource` is evaluated through `resolveInputAsync` (below), the same path every
// other `{{...}}` expression in this file takes — including the `$t[...]` dynamic locale bracket —
// so the engine has exactly one sandboxed-eval path, not two. Nothing outside this file calls this
// directly.
// eslint-disable-next-line @typescript-eslint/ban-types
async function evalInScope({ js, contextAsScope, functions, unresolvedReference, failOnUnreadablePath = false }: { js: string, contextAsScope: Record<string, unknown>, functions: Record<string, Function>, unresolvedReference?: { expression: string, stepNames: string[] }, failOnUnreadablePath?: boolean }): Promise<unknown> {
    const { data: result, error: resultError } = await utils.tryCatchAndThrowOnEngineError((async () => {
        const codeSandbox = await initCodeSandbox()

        return codeSandbox.runScript({
            script: js,
            scriptContext: contextAsScope,
            functions,
        })
    }))

    if (resultError) {
        if (failOnUnreadablePath && !isNil(unresolvedReference)) {
            throw new UnresolvedTemplateReferenceError({ expression: unresolvedReference.expression, cause: resultError })
        }
        assertReferenceIsResolvable({ error: resultError, unresolvedReference })
        console.warn('[evalInScope] Error evaluating variable', resultError)
        return ''
    }
    if (failOnUnreadablePath && result === undefined && !isNil(unresolvedReference)) {
        throw new UnresolvedTemplateReferenceError({ expression: unresolvedReference.expression })
    }
    return result ?? ''
}

// `{{VAR}}` — the short form everyone tries first — is evaluated against the run's step outputs,
// so it raised a ReferenceError that was swallowed into an empty string. That is the worst possible
// outcome: an empty string is a valid value everywhere, so the typo travelled downstream as wrong
// data, and as an HMAC key it silently reduced the signature to one anyone can forge (#392).
//
// Only a name that is not a step in this flow raises. A reference to a step that exists but has not
// run yet — a branch that was not taken, a step further down — still resolves to an empty string,
// which is long-standing behaviour and not what this is about. With no flow to check against
// (`stepNames` empty, e.g. the MCP single-action path) nothing can be decided, so nothing raises.
function assertReferenceIsResolvable({ error, unresolvedReference }: { error: Error, unresolvedReference?: { expression: string, stepNames: string[] } }): void {
    if (isNil(unresolvedReference) || unresolvedReference.stepNames.length === 0) {
        return
    }
    const match = /\b([A-Za-z_$][A-Za-z0-9_$]*) is not defined\b/.exec(error.message)
    if (isNil(match)) {
        return
    }
    const reference = match[1]
    if (unresolvedReference.stepNames.includes(reference)) {
        return
    }
    throw new UnresolvedTemplateReferenceError({ expression: unresolvedReference.expression, reference, cause: error })
}

function flattenNestedKeys(data: unknown, pathToMatch: string[]): unknown[] {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            if (key === pathToMatch[0]) {
                return flattenNestedKeys(value, pathToMatch.slice(1))
            }
        }
    }
    else if (Array.isArray(data)) {
        return data.flatMap((d) => flattenNestedKeys(d, pathToMatch))
    }
    else if (pathToMatch.length === 0) {
        return [data]
    }
    return []
}

type PreResolveOptions = Pick<ResolveInputInternalParams, 'engineToken' | 'projectId' | 'apiUrl' | 'currentState' | 'censoredInput' | 'contextVersion' | 'stepNames' | 'constants' | 'executionState' | 'resolvingLocaleSource'>

async function preResolveFormulaVars({ expression, resolveOptions }: {
    expression: string
    resolveOptions: PreResolveOptions
}): Promise<{ expression: string, vars: Record<string, unknown> }> {
    // Single-pass regex substitution with dedup: identical tokens map to the
    // same key and resolve once. The previous split/join loop created one key
    // per occurrence then replaced ALL occurrences with the first key,
    // leaving later keys orphaned in `vars`.
    const variableNameToKey = new Map<string, string>()
    const rewritten = expression.replace(/\{\{([^}]+)\}\}/g, (_, raw: string) => {
        const variableName = raw.trim()
        let key = variableNameToKey.get(variableName)
        if (key === undefined) {
            key = `__ap_pv${variableNameToKey.size}__`
            variableNameToKey.set(variableName, key)
        }
        return `{{${key}}}`
    })

    const vars: Record<string, unknown> = {}
    await Promise.all(
        Array.from(variableNameToKey.entries()).map(async ([variableName, key]) => {
            vars[key] = await resolveSingleToken({ variableName, ...resolveOptions })
        }),
    )

    return { expression: rewritten, vars }
}

type ResolveSingleTokenParams = {
    variableName: string
    currentState: Record<string, unknown>
    stepNames: string[]
    engineToken: string
    projectId: string
    apiUrl: string
    censoredInput: boolean
    contextVersion: ContextVersion | undefined
    constants: EngineConstants
    executionState: FlowExecutorContext
    // Set only on the resolveInputAsync call EngineConstants#resolveOwnLocaleSource itself makes to
    // evaluate `localeSource` — never by any other caller, so this is a property of THIS call chain,
    // not shared mutable state on `constants`. Lets handleTranslation short-circuit a `$t` nested
    // inside `localeSource` (directly or via a formula wrapper) to "no run locale yet" without ever
    // calling `constants.getRunLocale` again, so an unrelated concurrent `$t` resolution elsewhere in
    // the same run (a step with several `$t` fields resolved via `Promise.all`, or a concurrent loop
    // iteration) is never affected by it.
    resolvingLocaleSource?: boolean
}

export type ResolveInputInternalParams = {
    input: string
    stepNames: string[]
    engineToken: string
    projectId: string
    apiUrl: string
    censoredInput: boolean
    currentState: Record<string, unknown>
    contextVersion: ContextVersion | undefined
    constants: EngineConstants
    executionState: FlowExecutorContext
    resolvingLocaleSource?: boolean
}

type ResolveInputParams = {
    unresolvedInput: unknown
    executionState: FlowExecutorContext
}

type ResolveResult<T = unknown> = {
    resolvedInput: T
    censoredInput: unknown
}


type PropsResolverParams = {
    engineToken: string
    projectId: string
    apiUrl: string
    contextVersion: ContextVersion | undefined
    stepNames: string[]
    constants: EngineConstants
}
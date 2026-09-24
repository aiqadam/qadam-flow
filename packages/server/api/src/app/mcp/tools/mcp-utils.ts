import { PropertyType, QadamMetadataModel, QadamPropertyMap } from '@aiqadam/qadams-framework'
import { AgentQadamProps, AgentToolType, BranchOperator, ErrorCode, FlowActionType, flowStructureUtil, isNil, isObject, LoopCollectSettings, LoopKeepBodies, McpServerType, McpToolResult, ProjectScopedMcpServer, singleValueConditions } from '@aiqadam/shared'
import type { RouterAction, Step } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { expressionRewriter } from '../../flows/flow-version/migrations/expression-rewriter'
import { projectService } from '../../project/project-service'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'

const NON_INPUT_PROP_TYPES = new Set<PropertyType>([
    PropertyType.OAUTH2,
    PropertyType.SECRET_TEXT,
    PropertyType.BASIC_AUTH,
    PropertyType.CUSTOM_AUTH,
    PropertyType.MARKDOWN,
])

const INTERNAL_INPUT_KEYS = new Set(['auth'])

const RESOLVABLE_PROP_TYPES = new Set<PropertyType>([
    PropertyType.DROPDOWN,
    PropertyType.MULTI_SELECT_DROPDOWN,
    PropertyType.DYNAMIC,
])

const LOG_INPUT_HINT = 'Whether this step\'s input is written to the run log. Defaults to true. Set false when the input carries personal or secret data: the persisted log shows **REDACTED** while the step still runs on the real value.'
const LOG_OUTPUT_HINT = 'Whether this step\'s output is written to the run log. Defaults to true. Set false when the output carries personal or secret data (e.g. tables-update-record returns the whole row): the persisted log shows **REDACTED** while the value still flows to the next step.'
// Mirrors the engine's FILE processor (#388): anything else fails the step at run time.
const FILE_VALUE_HINT = 'FILE — pass an http(s) URL (e.g. {{step_1[\'output\'].file}}) or a data:<mime>;base64,<data> URI. Objects and bare base64 are rejected.'
// #41. Shared by ap_add_step, ap_update_step and ap_build_flow so the three describe one contract.
const LOOP_COLLECT_INPUT_SCHEMA = z.object({
    value: z.string().min(1),
    skipFailed: z.boolean().optional(),
})
const LOOP_KEEP_BODIES_INPUT_SCHEMA = z.enum(LoopKeepBodies)
const LOOP_COLLECT_HINT = 'For LOOP steps: collect one value per iteration into the loop output, so a step after the loop reads a flat list instead of walking iterations. `value` is a template evaluated at the end of each iteration, in that iteration\'s scope (e.g. "{{step_7[\'output\'].body.text}}" or "{{ { name: step_7[\'output\'].body.filename, text: step_7[\'output\'].body.text } }}"). After the loop read {{loopStep[\'output\'].collected}} — positional: entry i belongs to item i and is null for an iteration that failed or was skipped — and {{loopStep[\'output\'].failures}} (one { index, stepName, description } per failed iteration). skipFailed: also leave out an iteration in which a continue-on-failure step failed.'
const LOOP_KEEP_BODIES_HINT = 'For LOOP steps: which iteration bodies the run log keeps once an iteration is done. ALL (default) keeps every step output; FAILED_ONLY keeps only iterations with a failed step; NONE keeps none. Use FAILED_ONLY or NONE for loops over thousands of items so the run stays under the log size limit — collected, failures and the loop\'s own item/index are kept either way.'
const STEP_REFERENCE_HINT = 'Reference a prior step\'s output with {{stepName[\'output\'].field}} (output is nested under [\'output\'], e.g. {{trigger[\'output\'].body.email}}, {{send_email[\'output\'].id}}). For a continue-on-failure step\'s error, use {{stepName[\'error\'].description}} (readable text), {{stepName[\'error\'].status}} (HTTP status) or {{stepName[\'error\'].retryAfterSeconds}} (the wait a provider asked for on a 429); {{stepName[\'error\'].message}} is the raw stored error string.'

function mcpToolError(prefix: string, err: unknown): McpToolResult {
    // Every branch below is sanitized, including the two that read a `params.message` written by
    // our own code: this runs for all MCP tools, and the sanitizer's job is to keep a container
    // path out of a client-visible string no matter which throw site produced it.
    const entityDetail = extractQadamFlowErrorDetail({ err, code: ErrorCode.ENTITY_NOT_FOUND })
    if (entityDetail) {
        return { content: [{ type: 'text', text: `❌ ${prefix}: ${sanitizeErrorMessage(entityDetail)} not found. Check the ID or name and try again.` }], isError: true }
    }
    const validationDetail = extractQadamFlowErrorDetail({ err, code: ErrorCode.VALIDATION })
    if (validationDetail) {
        return { content: [{ type: 'text', text: `❌ ${prefix}: ${sanitizeErrorMessage(validationDetail)}` }], isError: true }
    }
    const raw = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `❌ ${prefix}: ${sanitizeErrorMessage(raw)}` }], isError: true }
}

// QadamFlowError's own `.message` getter only reflects its constructor's optional second
// argument, never `error.params.message` — so a plain `err.message` read here would show just
// the bare error code (e.g. "VALIDATION") for every caller that (like most in this codebase)
// puts the human-readable detail in `params.message` instead.
function extractQadamFlowErrorDetail({ err, code }: ExtractQadamFlowErrorDetailParams): string | null {
    if (!isObject(err)) return null
    const error = err.error
    if (!isObject(error)) return null
    if (error.code !== code) return null
    const params = error.params
    if (!isObject(params)) return null
    if (typeof params.message === 'string') return params.message
    if (code !== ErrorCode.ENTITY_NOT_FOUND) return null
    const entityType = typeof params.entityType === 'string' ? params.entityType : null
    const entityId = typeof params.entityId === 'string' ? params.entityId : null
    if (entityType) return `${entityType}${entityId ? ` "${entityId}"` : ''}`
    return entityId ? `"${entityId}"` : null
}

function sanitizeErrorMessage(message: string): string {
    return message
        .replace(/\/root\/codes\/[^\s:)]+/g, '<sandbox>')
        .replace(/\/root\/common\/[^\s:)]+/g, '<internal>')
        .replace(/\/home\/[^\s:)]+node_modules\/[^\s:)]+/g, '<internal>')
        .replace(/node_modules\/\.bun\/[^\s:)]+/g, '<internal>')
}

function formatOptionsHint(options: Array<{ label: string, value: unknown }> | undefined): string {
    if (!options || options.length === 0) {
        return ''
    }
    const values = options.map(o => String(o.value))
    if (values.length > 10) {
        return ` — options: ${values.slice(0, 10).join(', ')}... (${values.length} total)`
    }
    return ` — options: ${values.join(', ')}`
}

function diagnoseQadamProps({ props, input, qadamAuth, requireAuth, componentType }: DiagnoseQadamPropsParams): DiagnosisResult {
    const missing: string[] = []
    const uiRequired: string[] = []
    const allProps: string[] = []
    const validPropKeys = new Set<string>()
    for (const [propName, prop] of Object.entries(props)) {
        if (NON_INPUT_PROP_TYPES.has(prop.type)) {
            continue
        }
        validPropKeys.add(propName)
        allProps.push(`${propName} (${prop.type}${prop.required ? ', required' : ''})`)
        if (prop.required) {
            const value = input[propName]
            if (value === undefined || value === null || value === '') {
                if (RESOLVABLE_PROP_TYPES.has(prop.type)) {
                    uiRequired.push(`${propName} (${wrapUntrustedValue(prop.displayName)})`)
                }
                else {
                    const hint = (prop.type === PropertyType.STATIC_DROPDOWN || prop.type === PropertyType.STATIC_MULTI_SELECT_DROPDOWN)
                        ? formatOptionsHint(prop.options?.options)
                        : ''
                    missing.push(`${propName} (${prop.type}${hint})`)
                }
            }
        }
    }

    const unknownKeys = Object.keys(input).filter((key) => !validPropKeys.has(key) && !INTERNAL_INPUT_KEYS.has(key))

    const hasAuth = qadamAuth !== undefined && qadamAuth !== null && requireAuth
    if (hasAuth && !input.auth) {
        missing.push('auth (connection required — use ap_list_connections)')
    }
    const parts: string[] = []
    if (unknownKeys.length > 0) {
        // `prop.description`/`prop.displayName` are free text from whoever published or installed
        // the qadam, and these entries are joined with `\n` into a multi-line block — an
        // unwrapped newline inside one entry would forge an extra list item or a fake header
        // (#485 review, same source as the `auth.description` wrapped in `ap-setup-guide.ts`).
        const validPropDescriptions = Object.entries(props)
            .filter(([, prop]) => !NON_INPUT_PROP_TYPES.has(prop.type))
            .map(([name, prop]) => `- ${name} (${prop.type}): ${wrapUntrustedValue(prop.description ?? prop.displayName)}`)
            .join('\n')
        parts.push(`Unknown properties: ${unknownKeys.map((k) => `'${k}'`).join(', ')}. Valid properties for this action are:\n${validPropDescriptions}\nPlease retry with correct property names.`)
    }
    if (missing.length > 0) {
        parts.push(`Missing required inputs: ${missing.join(', ')}.`)
    }
    if (uiRequired.length > 0) {
        parts.push(`These inputs require selection from your account and must be configured in the Qadam Flow UI: ${uiRequired.join(', ')}.`)
    }
    if (allProps.length > 0 && unknownKeys.length === 0) {
        parts.push(`Expected inputs: ${allProps.join(', ')}.`)
    }
    if (hasAuth && !input.auth) {
        parts.push(`This ${componentType} requires authentication.`)
    }
    return { parts, missing, unknownKeys, uiRequired, hasAuth }
}

const MAX_PROP_DEPTH = 3

function buildPropSummaries(props: QadamPropertyMap, depth = 0): PropSummary[] {
    return Object.entries(props)
        .filter(([, prop]) => !NON_INPUT_PROP_TYPES.has(prop.type))
        .map(([name, prop]) => {
            const summary: PropSummary = {
                name,
                type: prop.type,
                required: prop.required ?? false,
                displayName: prop.displayName ?? name,
            }
            if (prop.description) {
                summary.description = prop.description
            }
            if (prop.defaultValue !== undefined) {
                summary.defaultValue = prop.defaultValue
            }
            if ((prop.type === PropertyType.STATIC_DROPDOWN || prop.type === PropertyType.STATIC_MULTI_SELECT_DROPDOWN) && 'options' in prop && prop.options?.options) {
                summary.options = prop.options.options.map((o: { label: string, value: unknown }) => ({ label: o.label, value: o.value }))
            }
            if (prop.type === PropertyType.DROPDOWN || prop.type === PropertyType.MULTI_SELECT_DROPDOWN) {
                summary.note = 'Resolve with ap_resolve_property_options. Use the returned value (ID), not label.'
            }
            if (prop.type === PropertyType.DYNAMIC) {
                summary.note = 'DYNAMIC — call ap_get_piece_props with auth+input to resolve sub-fields.'
            }
            if (prop.type === PropertyType.FILE) {
                summary.note = FILE_VALUE_HINT
            }
            if (prop.type === PropertyType.ARRAY && 'properties' in prop && isObject(prop.properties) && depth < MAX_PROP_DEPTH) {
                const arraySubProps: QadamPropertyMap = prop.properties
                summary.items = buildPropSummaries(arraySubProps, depth + 1)
            }
            return summary
        })
}

function normalizeQadamName(qadamName: string | undefined): string | undefined {
    if (isNil(qadamName)) {
        return undefined
    }
    if (qadamName.startsWith('@')) {
        return qadamName
    }
    const stripped = qadamName.startsWith('piece-') ? qadamName.slice('piece-'.length) : qadamName.startsWith('qadam-') ? qadamName.slice('qadam-'.length) : qadamName
    const normalized = stripped.replace(/_/g, '-')
    return `@aiqadam/qadam-${normalized}`
}

async function lookupQadamComponent({ qadamName, componentName, componentType, projectId, platformId, log }: LookupQadamComponentParams): Promise<LookupQadamComponentResult> {
    const normalized = normalizeQadamName(qadamName)
    if (isNil(normalized)) {
        return { error: mcpToolError('Validation failed', new Error('qadamName is required')) }
    }
    // platformId is needed so private (CUSTOM) qadams on this platform are discoverable.
    let resolvedPlatformId: string
    if (!isNil(platformId)) {
        resolvedPlatformId = platformId
    }
    else if (!isNil(projectId)) {
        resolvedPlatformId = (await projectService(log).getOneOrThrow(projectId)).platformId
    }
    else {
        return { error: mcpToolError('Validation failed', new Error('Either platformId or projectId is required to look up a qadam')) }
    }
    const qadam = await qadamMetadataService(log).get({ name: normalized, projectId, platformId: resolvedPlatformId })
    if (isNil(qadam)) {
        return { error: { content: [{ type: 'text', text: `❌ Qadam "${normalized}" not found. Use ap_research_pieces to get valid qadam names.` }] } }
    }
    const componentMap = componentType === 'action' ? qadam.actions : qadam.triggers
    const label = componentType === 'action' ? 'Action' : 'Trigger'
    const component = componentMap[componentName]
    if (isNil(component)) {
        // Action/trigger names are qadam-registration metadata — set by whoever published or
        // installed the qadam, with no naming regex behind them — so both the suggestion and the
        // full list are wrapped (#485).
        const available = Object.keys(componentMap)
        const suggestion = available.find((name) => name.includes(componentName))
        const hint = suggestion ? ` Did you mean ${wrapUntrustedValue(suggestion)}?` : ''
        return { error: { content: [{ type: 'text', text: `❌ ${label} "${componentName}" not found in "${normalized}".${hint} Available: ${available.map((name) => wrapUntrustedValue(name)).join(', ')}` }] } }
    }
    return { qadam, component, qadamName: normalized }
}

function findResolvableProps({ props, componentProps, auth, providedInput }: FindResolvablePropsParams): PropSummary[] {
    return props.filter(prop => {
        const propDef = componentProps[prop.name]
        if (isNil(propDef) || !RESOLVABLE_PROP_TYPES.has(prop.type) || !('refreshers' in propDef)) {
            return false
        }
        const refreshers = (propDef as { refreshers: string[] }).refreshers
        return refreshers.every(r => r === 'auth' ? !!auth : providedInput[r] !== undefined)
    })
}

const SINGLE_VALUE_OPERATORS_HINT = singleValueConditions.join(', ')
const BRANCH_CONDITIONS_INPUT_SCHEMA = z.array(
    z.array(
        z.object({
            firstValue: z.string().min(1, 'firstValue must be a non-empty string or template expression (e.g. {{trigger[\'output\'].field}})').describe('Left-hand value (template expressions like {{step_1[\'output\'].field}} are allowed). Must be non-empty.'),
            operator: z.enum(Object.values(BranchOperator) as [BranchOperator, ...BranchOperator[]]).optional().describe(`Comparison operator. Single-value operators (no secondValue needed): ${SINGLE_VALUE_OPERATORS_HINT}.`),
            secondValue: z.string().min(1, 'secondValue must be a non-empty string when provided').optional().describe('Right-hand value (template expressions like {{step_1[\'output\'].field}} are allowed) — required (and non-empty) for all operators except single-value ones.'),
            caseSensitive: z.boolean().optional().describe('For text operators: whether to match case sensitively'),
        }).superRefine((cond, ctx) => {
            if (cond.operator !== undefined
                && !(singleValueConditions as BranchOperator[]).includes(cond.operator)
                && cond.secondValue === undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['secondValue'],
                    message: `secondValue is required when operator is "${cond.operator}". Use a single-value operator (${SINGLE_VALUE_OPERATORS_HINT}) if you do not have a secondValue.`,
                })
            }
            if (cond.operator === undefined && cond.secondValue !== undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['operator'],
                    message: 'operator is required when secondValue is provided — pick a comparison operator (e.g. TEXT_CONTAINS, TEXT_EXACTLY_MATCHES, NUMBER_IS_EQUAL_TO).',
                })
            }
        }),
    ),
)

// Any string an MCP tool renders that did not originate from this call's own arguments — a
// step's displayName, a qadam/action/trigger/branch name, a pinned qadam version, a truncated
// sourceCode/input preview, a connection/table/field/variable/project display name, a qadam's own
// registration metadata (displayName, auth description, prop labels — set by whoever published or
// installed that qadam), or a third-party API's response body / error string surfaced through a
// run's output or errorMessage — was written by a principal other than whoever is running this tool
// call (#480, widened by #485 past the original flow-definition-only perimeter: a flow calling an
// attacker-controlled URL reaches this content with no project-write access needed at all).
// Interpolating it bare into a warning or summary line hands that other author a reliable,
// agent-chosen slot inside text the model reads as the tool's own voice: a name need only fail to
// resolve, or a request need only fail, to guarantee the surrounding sentence fires, and nothing
// stops the value from reading as an instruction itself.
//
// This does not reject the value — a name that fails to resolve, or a call that failed, is exactly
// the normal case this output exists to report — but it is not a lossless passthrough either: it
// marks where the tool's prose ends and quoted, untrusted data begins with a delimiter no legitimate
// value handled this way is allowed to collide with, and that guarantee costs the value any literal
// occurrence of the delimiter itself (and of a short list of characters that merely *look* like it —
// see `CONFUSABLE_DELIMITERS`), which are stripped rather than escaped. Two rounds of review landed
// on different lists here, and the second is the one that stands: the real delimiter is a single
// codepoint no input can forge by concatenation, so stripping the ASCII `[[`/`]]` pair bought no
// closure that guarantee didn't already provide — and it corrupted ordinary JSON/JS
// array-of-arrays syntax (`[[1,2],[3,4]]` became `1,2],[3,4`), so that pair is gone for good. The six
// non-ASCII look-alikes (`〚〛〖〗⦋⦌`) answer a different question — not whether the
// delimiter can be forged, but whether a reader matching loosely on shape rather than codepoint could
// still mistake one for a close. None of them appears in JSON or JavaScript syntax, so keeping them
// costs no *syntax* fidelity — but that is not the same as costing nothing: U+3016/U+3017 (`〖〗`)
// and U+301A/U+301B (`〚〛`) are ordinary Chinese/Japanese typographic brackets, so a legitimate CJK
// value like `〖重要〗` silently renders as `⟦重要⟧`, indistinguishable from this wrapper's own
// delimiter. That cost is accepted knowingly, not overlooked: this list has been revised twice on
// review input and made worse both times, so it is deliberately staying as-is here; the raw,
// unmodified value remains available to a caller that needs it exact via `structuredContent` on
// every tool that surfaces one. Every ECMAScript line-terminator
// (not just `\r`/`\n` — `\u2028`/`\u2029` render as breaks in many consumers, and `\u0085`/`\v`/`\f`
// are the remaining vertical-whitespace forms) is collapsed to a space first, so one value cannot
// masquerade as several lines of trusted output — collapsing is the control the whole design rests
// on, since a fabricated line is what lets injected text imitate one of this tool's own section
// headers or list items. The result is quoted, not verbatim: line breaks are flattened and the
// delimiter (and its look-alikes) cannot survive inside it, so a caller must not treat a wrapped span
// as a byte-for-byte copy of the stored value. `wrapUntrustedValue` takes `string | null | undefined`,
// not `unknown`, so an object or array is a compile-time error rather than silently printing
// `[object Object]` — but the body still runs every value through `String(...)` before replacing,
// because the narrowed type is a compile-time promise, not a runtime guarantee: a jsonb-backed column
// typed `string` can legally hold a number, a boolean, or `null`/`undefined` at runtime, and only the
// last two were still handled once the `typeof value === 'string' ? value : String(value ?? '')` line
// was simplified away — a number or boolean reaching this function's runtime, however that happens,
// must not throw on `.replace`.
const UNTRUSTED_VALUE_OPEN = '⟦'
const UNTRUSTED_VALUE_CLOSE = '⟧'
// Characters that read as "the same kind of bracket" as the real delimiter to a casual glance, or to
// a model matching loosely on shape rather than codepoint — none of these is
// `UNTRUSTED_VALUE_OPEN`/`UNTRUSTED_VALUE_CLOSE`, so a naive strip would miss them, and none of them
// appears in JSON or JavaScript syntax (unlike the ASCII `[[`/`]]` pair this list used to carry, which
// corrupted array-of-arrays JSON for no benefit — removed, see the comment above).
const CONFUSABLE_DELIMITERS = ['〚', '〛', '〖', '〗', '⦋', '⦌']
const LINE_BREAK_PATTERN = /[\r\n\u2028\u2029\u0085\v\f]+/g
// A bidi embedding/override (U+202A-U+202E) or isolate (U+2066-U+2069) is not terminated by the
// closing delimiter -- only by its own matching pop character (U+202C, U+2069) or a paragraph
// break -- so an unpaired opener surviving inside a wrapped value reorders the rendering of
// everything the client prints after the closing bracket, including this tool's own trusted prose
// in the web chat UI (#485 review). Appending one U+202C/U+2069 after wrapping does not reliably
// close this either: UAX#9 allows up to 125 levels of embedding, so ten openers need ten matching
// terminators, not one. Only removing the codepoints closes the gap. The cost is the same class of
// accepted lossiness as the line-terminator collapse above: a value that legitimately used bidi
// formatting loses it, and the raw value stays available via `structuredContent` for a caller that
// needs it exact.
const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/g

function wrapUntrustedValue(value: string | null | undefined): string {
    const str = typeof value === 'string' ? value : String(value ?? '')
    const collapsed = str.replace(LINE_BREAK_PATTERN, ' ').replace(BIDI_CONTROL_PATTERN, '')
    const sanitized = [UNTRUSTED_VALUE_OPEN, UNTRUSTED_VALUE_CLOSE, ...CONFUSABLE_DELIMITERS]
        .reduce((acc, token) => acc.split(token).join(''), collapsed)
    return `${UNTRUSTED_VALUE_OPEN}${sanitized}${UNTRUSTED_VALUE_CLOSE}`
}

// The truncation marker is deliberately appended *after* wrapping, not baked into the content that
// gets wrapped: appending it inside the delimiter would let a long enough value truncate the marker
// itself away, and computing it before wrapping would let the value forge it. Wrapping the raw,
// possibly-truncated content last is what stops the closing bracket from being truncated away in
// the first place — this keeps that property and adds the same guarantee for the marker text.
function wrapTruncatedUntrustedValue({ value, max }: { value: string, max: number }): string {
    const isTruncated = value.length > max
    const content = isTruncated ? value.slice(0, max) : value
    return `${wrapUntrustedValue(content)}${isTruncated ? '... (truncated)' : ''}`
}

function resolveRouterStep({ stepName, trigger }: { stepName: string, trigger: Step }): ResolveRouterStepResult {
    const step = flowStructureUtil.getStep(stepName, trigger)
    if (isNil(step) || step.type !== FlowActionType.ROUTER) {
        const routers = flowStructureUtil.getAllSteps(trigger)
            .filter(s => s.type === FlowActionType.ROUTER)
            .map(s => s.name)
            .join(', ')
        return {
            error: { content: [{ type: 'text', text: `❌ Step "${stepName}" is not a ROUTER step. Available routers: ${routers || 'none'}` }] },
        }
    }
    return { routerStep: step as RouterAction }
}

function routerInvalidWarning({ stepName, trigger }: { stepName: string, trigger: Step }): string {
    const step = flowStructureUtil.getStep(stepName, trigger)
    if (isNil(step) || step.valid) {
        return ''
    }
    return `\n⚠️ The router "${stepName}" is now marked invalid (step.valid=false) — the UI will show "Incomplete" and the flow cannot be published. Inspect the branch conditions with ap_flow_structure: every non-fallback branch needs at least one condition (a branch that asserts nothing can never match — configure it with ap_update_branch or drop it with ap_delete_branch), every condition needs a non-empty firstValue, and any non-single-value operator (TEXT_*, NUMBER_*, DATE_*, LIST_CONTAINS/LIST_DOES_NOT_CONTAIN) needs a non-empty secondValue.`
}

function publishedFlowWarning(publishedVersionId: string | null | undefined): string {
    if (isNil(publishedVersionId)) {
        return ''
    }
    return '\n⚠️ This flow is published. Changes apply to the draft only — use ap_lock_and_publish to push them live.'
}

// `ap_list_connections` now renders `externalId: ⟦my-gmail⟧` and tells the model that's the value
// for the `auth` param — so the delimiters themselves must fail this check, not just the ASCII
// brackets/quotes the flow-templating syntax cares about. Without this, a model that copies the
// bracketed form in verbatim passes validation here, `ap-add-step.ts` bakes
// `{{connections['⟦my-gmail⟧']}}` into the flow, and it fails at RUN time on a value that looks
// identical to the correct one (#485 review).
const AUTH_INVALID_CHARS = /['{}[\]⟦⟧]/

function validateAuth(auth: string | undefined): { content: [{ type: 'text', text: string }] } | null {
    if (auth !== undefined && AUTH_INVALID_CHARS.test(auth)) {
        return { content: [{ type: 'text', text: '❌ auth must be a plain externalId with no special characters. Use the exact value from ap_list_connections.' }] }
    }
    return null
}

async function fillDefaultsForMissingOptionalProps({ settings, platformId, log }: {
    settings: Record<string, unknown>
    platformId: string
    log: FastifyBaseLogger
}): Promise<void> {
    const qadamName = settings.qadamName
    const qadamVersion = settings.qadamVersion
    const actionName = settings.actionName
    if (typeof qadamName !== 'string' || typeof qadamVersion !== 'string' || typeof actionName !== 'string') {
        return
    }
    try {
        const qadam = await qadamMetadataService(log).getOrThrow({ platformId, name: qadamName, version: qadamVersion })
        const action = qadam.actions[actionName]
        if (isNil(action)) {
            return
        }
        const defaults: Record<string, unknown> = {}
        for (const [propName, prop] of Object.entries(action.props)) {
            if (prop.type === PropertyType.ARRAY && !prop.required) {
                defaults[propName] = []
            }
            else if (prop.type === PropertyType.DYNAMIC && !prop.required) {
                defaults[propName] = {}
            }
            else if (prop.type === PropertyType.CHECKBOX && !prop.required) {
                defaults[propName] = prop.defaultValue ?? false
            }
        }
        settings.input = { ...defaults, ...(typeof settings.input === 'object' && settings.input !== null ? settings.input : {}) }
    }
    catch (err) {
        log.warn({ err, qadamName, actionName }, 'fillDefaultsForMissingOptionalProps: failed, skipping defaults')
    }
}

function buildErrorHandlingOptions({ continueOnFailure, retryOnFailure }: {
    continueOnFailure?: boolean
    retryOnFailure?: boolean
}): { continueOnFailure: { value: boolean }, retryOnFailure: { value: boolean } } {
    return {
        continueOnFailure: { value: continueOnFailure ?? false },
        retryOnFailure: { value: retryOnFailure ?? false },
    }
}

async function resolveLatestQadamVersion({ qadamName, projectId, platformId, log }: {
    qadamName: string
    projectId: string
    platformId: string
    log: FastifyBaseLogger
}): Promise<ResolveLatestQadamVersionResult> {
    const normalized = normalizeQadamName(qadamName)
    if (isNil(normalized)) {
        return { error: mcpToolError('Validation failed', new Error('qadamName is required')) }
    }
    const qadam = await qadamMetadataService(log).get({ name: normalized, projectId, platformId })
    if (isNil(qadam)) {
        return { error: { content: [{ type: 'text', text: `❌ Qadam "${normalized}" not found. Use ap_research_pieces to get valid qadam names.` }] } }
    }
    return { qadamVersion: `~${qadam.version}`, normalizedPieceName: normalized }
}

function withTimeout<T>({ promise, ms }: { promise: Promise<T>, ms: number }): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
        }),
    ])
}

async function resolvePlatformId({ mcp, log }: { mcp: ProjectScopedMcpServer, log: FastifyBaseLogger }): Promise<string> {
    if (mcp.platformId) {
        return mcp.platformId
    }
    const project = await projectService(log).getOneOrThrow(mcp.projectId)
    return project.platformId
}

function isProjectScoped(mcp: ProjectScopedMcpServer): boolean {
    return mcp.type === McpServerType.PROJECT
}

function rewriteAllReferences<C = unknown>({ input, loopItems, loopCollect, conditions, trigger }: {
    input?: Record<string, unknown>
    loopItems?: string
    loopCollect?: LoopCollectSettings
    conditions?: C
    trigger: Step
}): { input?: Record<string, unknown>, loopItems?: string, loopCollect?: LoopCollectSettings, conditions?: C } {
    const stepNames = flowStructureUtil.getAllSteps(trigger).map(s => s.name)
    return {
        input: input ? expressionRewriter.rewriteDeep(input, stepNames, true) : undefined,
        loopItems: loopItems != null ? expressionRewriter.rewriteStepReferences({ input: loopItems, stepNames, idempotent: true }) : loopItems,
        loopCollect: loopCollect != null ? { ...loopCollect, value: expressionRewriter.rewriteStepReferences({ input: loopCollect.value, stepNames, idempotent: true }) } : loopCollect,
        conditions: conditions ? expressionRewriter.rewriteDeep(conditions, stepNames, true) : conditions,
    }
}

// `externalFlowId` on an agent FLOW tool is a free-text property, and every MCP tool that surfaces
// a flow reports its primary key rather than its `externalId` — so an MCP client can only ever put
// an `id` there. Rewriting it at write time keeps what lands in the database unambiguous.
// `externalId` wins over `id` on a collision, matching the runtime lookup in the AI qadam.
function rewriteAgentFlowToolIds({ input, flows }: {
    input: Record<string, unknown> | undefined
    flows: Array<{ id: string, externalId: string }>
}): Record<string, unknown> | undefined {
    const tools = readAgentFlowTools(input)
    if (isNil(input) || isNil(tools)) {
        return input
    }
    const knownExternalIds = new Set(flows.map(flow => flow.externalId))
    const externalIdById = new Map(flows.map(flow => [flow.id, flow.externalId]))
    return {
        ...input,
        [AgentQadamProps.AGENT_TOOLS]: tools.map((tool) => {
            const reference = readFlowToolReference(tool)
            if (isNil(reference) || knownExternalIds.has(reference)) {
                return tool
            }
            const externalId = externalIdById.get(reference)
            if (isNil(externalId) || !isObject(tool)) {
                return tool
            }
            return { ...tool, externalFlowId: externalId }
        }),
    }
}

async function normalizeAgentFlowToolIds({ input, projectId, log }: {
    input: Record<string, unknown> | undefined
    projectId: string
    log: FastifyBaseLogger
}): Promise<Record<string, unknown> | undefined> {
    const references = (readAgentFlowTools(input) ?? [])
        .map(readFlowToolReference)
        .filter((reference): reference is string => !isNil(reference))
    if (references.length === 0) {
        return input
    }
    const flows = await flowService(log).list({ projectIds: [projectId], externalIdsOrIds: references })
    return rewriteAgentFlowToolIds({ input, flows: flows.data })
}

function readAgentFlowTools(input: Record<string, unknown> | undefined): unknown[] | null {
    const tools = input?.[AgentQadamProps.AGENT_TOOLS]
    return Array.isArray(tools) ? tools : null
}

function readFlowToolReference(tool: unknown): string | null {
    if (!isObject(tool) || tool.type !== AgentToolType.FLOW) {
        return null
    }
    const externalFlowId = tool.externalFlowId
    return typeof externalFlowId === 'string' && externalFlowId.length > 0 ? externalFlowId : null
}

// Single source of the wording for a qadam pin's resolvability, shared by `ap_validate_flow` and
// `ap_flow_structure` so the two tools cannot tell an agent contradictory things about the same
// fact. `qadamPinUtil.resolvePins` is tri-state; `false` is a confirmed miss, and only there is the
// destructive remedy (delete-and-re-add) warranted. `undefined` means the check itself failed —
// this must never claim the pin definitely does not exist, and must never advise destroying the
// step's sample data based on a reading that was never actually verified (#474).
function qadamPinIssue({ pin, resolvable }: { pin: string, resolvable: boolean | undefined }): QadamPinIssue | null {
    if (resolvable === true) {
        return null
    }
    if (resolvable === false) {
        return {
            severity: 'unavailable',
            message: `is pinned to ${wrapUntrustedValue(pin)}, which this installation does not have. Every run and every trigger provisioning attempt fails on it. Re-point it at an available version — delete and re-add the step with ap_add_step, or re-create the trigger with ap_update_trigger.`,
        }
    }
    return {
        severity: 'unverified',
        message: `is pinned to ${wrapUntrustedValue(pin)}, and this installation could not confirm right now whether that version is available (the check failed transiently). Re-run before acting on this — do not delete or re-add the step based on an unverified reading, since that loses its sample data.`,
    }
}

function extractOptionsArray(options: unknown): Array<{ label: string, value: unknown }> | null {
    if (Array.isArray(options)) return options

    if (isObject(options)) {
        const obj = options as Record<string, unknown>
        if (Array.isArray(obj.options)) {
            return obj.options as Array<{ label: string, value: unknown }>
        }
    }

    return null
}

const RESOLVE_TIMEOUT_MS = 30_000

export const mcpUtils = {
    mcpToolError,
    wrapUntrustedValue,
    wrapTruncatedUntrustedValue,
    resolveRouterStep,
    routerInvalidWarning,
    publishedFlowWarning,
    diagnoseQadamProps,
    buildPropSummaries,
    normalizeQadamName,
    lookupQadamComponent,
    findResolvableProps,
    validateAuth,
    fillDefaultsForMissingOptionalProps,
    buildErrorHandlingOptions,
    resolveLatestQadamVersion,
    resolvePlatformId,
    isProjectScoped,
    withTimeout,
    rewriteAllReferences,
    rewriteAgentFlowToolIds,
    normalizeAgentFlowToolIds,
    extractOptionsArray,
    qadamPinIssue,
    RESOLVE_TIMEOUT_MS,
    STEP_REFERENCE_HINT,
    LOOP_COLLECT_INPUT_SCHEMA,
    LOOP_KEEP_BODIES_INPUT_SCHEMA,
    LOOP_COLLECT_HINT,
    LOOP_KEEP_BODIES_HINT,
    LOG_INPUT_HINT,
    LOG_OUTPUT_HINT,
    BRANCH_CONDITIONS_INPUT_SCHEMA,
}

export type { PropSummary, QadamPinIssue }

type ExtractQadamFlowErrorDetailParams = {
    err: unknown
    code: ErrorCode.ENTITY_NOT_FOUND | ErrorCode.VALIDATION
}

type FindResolvablePropsParams = {
    props: PropSummary[]
    componentProps: QadamPropertyMap
    auth: string | undefined
    providedInput: Record<string, unknown>
}

type DiagnoseQadamPropsParams = {
    props: QadamPropertyMap
    input: Record<string, unknown>
    qadamAuth: unknown
    requireAuth: boolean
    componentType: 'action' | 'trigger'
}

type DiagnosisResult = {
    parts: string[]
    missing: string[]
    unknownKeys: string[]
    uiRequired: string[]
    hasAuth: boolean
}

type PropSummary = {
    name: string
    type: PropertyType
    required: boolean
    displayName: string
    description?: string
    defaultValue?: unknown
    options?: Array<{ label: string, value: unknown }>
    dynamicFields?: PropSummary[]
    items?: PropSummary[]
    note?: string
}

type LookupQadamComponentParams = {
    qadamName: string
    componentName: string
    componentType: 'action' | 'trigger'
    projectId: string | undefined
    platformId?: string
    log: FastifyBaseLogger
}

type LookupQadamComponentResult =
    | { qadam: QadamMetadataModel, component: { props: QadamPropertyMap, requireAuth: boolean, name: string, displayName: string, description: string }, qadamName: string, error?: never }
    | { error: McpToolResult, qadam?: never, component?: never, qadamName?: never }

type ResolveRouterStepResult =
    | { routerStep: RouterAction, error?: never }
    | { error: McpToolResult, routerStep?: never }

type ResolveLatestQadamVersionResult =
    | { qadamVersion: string, normalizedPieceName: string, error?: never }
    | { error: McpToolResult, qadamVersion?: never, normalizedPieceName?: never }

type QadamPinIssue = {
    severity: 'unavailable' | 'unverified'
    message: string
}

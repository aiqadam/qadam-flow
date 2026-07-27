import dayjs from 'dayjs'
import relativeTimeDayjs from 'dayjs/plugin/relativeTime'
import timezoneDayjs from 'dayjs/plugin/timezone'
import utcDayjs from 'dayjs/plugin/utc'
import { Parser } from 'expr-eval'
import { FORMULA_MAX_BUILT_STRING_LENGTH, FORMULA_MAX_JSON_VALUE_BUDGET, FormulaSizeLimitError, measureSize } from './formula-bounds'
import { AP_FUNCTIONS } from './function-registry'

dayjs.extend(relativeTimeDayjs)
dayjs.extend(timezoneDayjs)
dayjs.extend(utcDayjs)

// expr-eval's published `Values` type is `Record<string, number>` but the
// runtime accepts arrays, null, and mixed-type objects fine. Widen the
// `evaluate` overload via module augmentation so consumers don't need
// `@ts-expect-error` or `as` casts. Must be `interface` (not `type`) — only
// interface declarations merge with the third-party class declaration.
declare module 'expr-eval' {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Parser {
        evaluate(expression: string, values: Record<string, unknown>): unknown
    }
}

// Parser is a module-private singleton — exposing it would let any consumer
// of @aiqadam/shared mutate `parser.functions.X` and break formula
// evaluation process-wide. Use `evaluateRaw` instead.
const parser = new Parser()

// A per-call cap on each size-generating function (replace/join_list/
// to_json/from_json) is not enough: every call gets a FRESH allowance, so
// chaining N individually-capped calls together (e.g. via suffix()/
// combine(), which are themselves unguarded concatenation) can still produce
// N times the intended ceiling — the exact defect class rejected in earlier
// review rounds. These two mutable trackers are shared by every guarded
// function call within ONE evaluateRaw() invocation, so the SUM of what
// they've each produced is what's bounded, not each call in isolation.
//
// The heavier alternative — constructing a fresh Parser + function registry
// per evaluation so each guard closes over its own counter — was considered
// and rejected: `parser.functions` registers ~80 functions today, and
// re-registering all of them on every single formula evaluation (a hot path
// during flow execution) would trade a security fix for a real per-run cost.
// A module-level mutable tracker, reset in a try/finally around the one
// `parser.evaluate()` call, gets the same "shared budget for this
// evaluation" property without rebuilding the registry. This relies on
// `parser.functions.*` only ever running synchronously inside that
// try-block — true today (expr-eval has no async support) — so there is no
// concurrent evaluation that could see another call's tracker.
let currentBuiltStringBudget: { remaining: number } | null = null
let currentJsonValueBudget: { remaining: number } | null = null

export function evaluateRaw(expression: string, vars: Record<string, unknown>): unknown {
    currentBuiltStringBudget = { remaining: FORMULA_MAX_BUILT_STRING_LENGTH }
    currentJsonValueBudget = { remaining: FORMULA_MAX_JSON_VALUE_BUDGET }
    try {
        return parser.evaluate(expression, vars)
    }
    finally {
        currentBuiltStringBudget = null
        currentJsonValueBudget = null
    }
}

// Debits `amount` from the shared tracker for the current evaluation and
// reports whether that tips it over. A `null` tracker means this ran outside
// evaluateRaw's try-block — should not happen, but treated as "exceeds"
// rather than silently allowing unbounded output if it ever does.
function chargeSharedBudget({ tracker, amount }: { tracker: { remaining: number } | null, amount: number }): boolean {
    if (tracker === null) return true
    tracker.remaining -= amount
    return tracker.remaining < 0
}

parser.functions.combine = (a: unknown, b: unknown, sep: unknown = '') =>
    `${a ?? ''}${String(sep)}${b ?? ''}`
parser.functions.uppercase = (s: unknown) => String(s ?? '').toUpperCase()
parser.functions.lowercase = (s: unknown) => String(s ?? '').toLowerCase()
parser.functions.titlecase = (s: unknown) =>
    String(s ?? '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
parser.functions.trim = (s: unknown) => String(s ?? '').trim()
parser.functions.prefix = (s: unknown, pfx: unknown) => `${String(pfx ?? '')}${String(s ?? '')}`
parser.functions.suffix = (s: unknown, sfx: unknown) => `${String(s ?? '')}${String(sfx ?? '')}`
parser.functions.replace = (s: unknown, from: unknown, to: unknown) => {
    const str = String(s ?? '')
    const fromStr = String(from ?? '')
    const toStr = String(to ?? '')
    // replace() is `split(from).join(to)` under the hood, whose result length
    // is multiplicative (`|s| / |from| * |to|`), not additive — a modest `s`
    // and `to` can still build a gigabytes-large result. Project the length
    // from an occurrence count instead of running the real split/join, so a
    // rejection costs O(|s|) rather than O(the oversized result). Charged
    // against the shared per-evaluation tracker, not a fresh per-call
    // allowance, so chaining many replace() calls can't each get their own
    // budget.
    const projected = projectedSplitJoinLength({ source: str, from: fromStr, to: toStr })
    if (chargeSharedBudget({ tracker: currentBuiltStringBudget, amount: projected })) {
        throw new FormulaSizeLimitError('Result of replace() is too large to build')
    }
    return str.split(fromStr).join(toStr)
}
// remove() joins with '' (`s.split(sub).join('')`), so it can only shrink or
// preserve its input's length — never amplify. It is deliberately left
// unguarded: an earlier version guarded it "for consistency", but that guard
// was reachable (via chained calls feeding it an input that had legitimately
// grown large elsewhere) and produced a FALSE rejection on a value remove()
// itself never made larger. A guard that fires without the operation it
// guards against being possible is a bug, not defense-in-depth.
parser.functions.remove = (s: unknown, sub: unknown) =>
    String(s ?? '').split(String(sub ?? '')).join('')
parser.functions.first_n = (s: unknown, n: unknown) =>
    String(s ?? '').slice(0, Number(n))
parser.functions.last_n = (s: unknown, n: unknown) => {
    const str = String(s ?? '')
    const num = Number(n)
    return str.slice(Math.max(0, str.length - num))
}
parser.functions.truncate = (s: unknown, n: unknown) => {
    const str = String(s ?? '')
    const num = Number(n)
    return str.length > num ? str.slice(0, num) + '...' : str
}
parser.functions.split = (s: unknown, sep: unknown, idx: unknown) => {
    const parts = String(s ?? '').split(String(sep ?? ''))
    return parts[Number(idx)] ?? ''
}
parser.functions.extract_between = (s: unknown, start: unknown, end: unknown) => {
    const str = String(s ?? '')
    const startStr = String(start ?? '')
    const endStr = String(end ?? '')
    const si = str.indexOf(startStr)
    if (si === -1) return ''
    const ei = str.indexOf(endStr, si + startStr.length)
    if (ei === -1) return ''
    return str.slice(si + startStr.length, ei)
}
parser.functions.extract_email = (s: unknown) => {
    const match = String(s ?? '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
    return match ? match[0] : ''
}
parser.functions.extract_url = (s: unknown) => {
    const match = String(s ?? '').match(/https?:\/\/[^\s]+/)
    return match ? match[0] : ''
}
parser.functions.length = (s: unknown) => String(s ?? '').length
parser.functions.contains = (s: unknown, sub: unknown) =>
    String(s ?? '').includes(String(sub ?? ''))
parser.functions.starts_with = (s: unknown, prefix: unknown) =>
    String(s ?? '').startsWith(String(prefix ?? ''))
parser.functions.ends_with = (s: unknown, suffix: unknown) =>
    String(s ?? '').endsWith(String(suffix ?? ''))
parser.functions.remove_spaces = (s: unknown) =>
    String(s ?? '').replace(/\s+/g, ' ').trim()
parser.functions.word_count = (s: unknown) =>
    String(s ?? '').trim().split(/\s+/).filter(Boolean).length

parser.functions.add = (a: unknown, b: unknown) => Number(a) + Number(b)
parser.functions.subtract = (a: unknown, b: unknown) => Number(a) - Number(b)
parser.functions.multiply = (a: unknown, b: unknown) => Number(a) * Number(b)
parser.functions.divide = (a: unknown, b: unknown) => {
    const divisor = Number(b)
    if (divisor === 0) throw new Error('Division by zero')
    return Number(a) / divisor
}
// expr-eval has a built-in 1-arg `round` that shadows our 2-arg version,
// so we alias to ap_round and rewrite in normalizeExpression
parser.functions.ap_round = (n: unknown, decimals: unknown = 0) =>
    Number(Number(n).toFixed(Number(decimals)))
parser.functions.round_up = (n: unknown) => Math.ceil(Number(n))
parser.functions.round_down = (n: unknown) => Math.floor(Number(n))
parser.functions.absolute = (n: unknown) => Math.abs(Number(n))
parser.functions.percentage = (n: unknown, total: unknown) => {
    const divisor = Number(total)
    if (divisor === 0) throw new Error('Division by zero')
    return (Number(n) / divisor) * 100
}
parser.functions.format_number = (n: unknown, decimals: unknown = 0) => {
    const d = Number(decimals)
    return Number(n).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
    })
}
parser.functions.format_currency = (n: unknown, symbol: unknown = '$') =>
    `${String(symbol)}${Number(n).toFixed(2)}`
parser.functions.cents_to_dollars = (n: unknown) =>
    `$${(Number(n) / 100).toFixed(2)}`
parser.functions.min = (a: unknown, b: unknown) => Math.min(Number(a), Number(b))
parser.functions.max = (a: unknown, b: unknown) => Math.max(Number(a), Number(b))
parser.functions.to_number = (s: unknown) => Number(s)

parser.functions.format_date = (d: unknown, pattern: unknown = 'YYYY-MM-DD') => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.format(String(pattern)) : ''
}
parser.functions.format_date_long = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    if (!parsed.isValid()) return ''
    return parsed.toDate().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
}
parser.functions.format_time = (d: unknown, pattern: unknown = 'HH:mm') => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.format(String(pattern)) : ''
}
parser.functions.relative_time = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.fromNow() : ''
}
parser.functions.add_days = (d: unknown, n: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.add(Number(n), 'day').toISOString() : ''
}
parser.functions.subtract_days = (d: unknown, n: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.subtract(Number(n), 'day').toISOString() : ''
}
parser.functions.add_hours = (d: unknown, n: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.add(Number(n), 'hour').toISOString() : ''
}
parser.functions.days_between = (a: unknown, b: unknown) => {
    const da = dayjs(String(a ?? ''))
    const db = dayjs(String(b ?? ''))
    if (!da.isValid() || !db.isValid()) return ''
    return Math.round(Math.abs(db.diff(da, 'day', true)))
}
parser.functions.get_day = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.date() : ''
}
parser.functions.get_month = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.toDate().toLocaleDateString('en-US', { month: 'long' }) : ''
}
parser.functions.get_year = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.year() : ''
}
parser.functions.get_day_of_week = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.toDate().toLocaleDateString('en-US', { weekday: 'long' }) : ''
}
parser.functions.start_of_month = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.startOf('month').toISOString() : ''
}
parser.functions.end_of_month = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.endOf('month').toISOString() : ''
}
parser.functions.convert_timezone = (d: unknown, tz: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    if (!parsed.isValid()) return ''
    return parsed.tz(String(tz ?? 'UTC')).format()
}
parser.functions.now = () => new Date().toISOString()
parser.functions.today = () => dayjs().format('YYYY-MM-DD')
parser.functions.to_date = (d: unknown) => {
    const parsed = dayjs(String(d ?? ''))
    return parsed.isValid() ? parsed.toISOString() : ''
}

// Loose equality is intentional throughout: formula args arrive as strings from
// text input, while item fields are typed (`{age: 25}`). `===` would silently
// return zero matches when filtering numeric fields with string args. Same
// rationale applies to is_equal, switch, if_null below.
parser.functions.filter_list = (list: unknown, field: unknown, value: unknown, operator: unknown = 'equals') =>
    toArray(list).filter((item) => matchesOperator(readPath(item, String(field)), value, String(operator)))
parser.functions.sort_list = (list: unknown, field: unknown, order: unknown = 'asc') => {
    const arr = [...toArray(list)]
    const fieldName = String(field)
    const ord = String(order)
    return arr.sort((a, b) => {
        const av = readField(a, fieldName)
        const bv = readField(b, fieldName)
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return ord === 'desc' ? -cmp : cmp
    })
}
parser.functions.pluck = (list: unknown, field: unknown) =>
    toArray(list).map((item) => readPath(item, String(field)))
parser.functions.find_by = (list: unknown, field: unknown, value: unknown) =>
    // Loose equality mirrors filter_list: formula args arrive as strings from
    // text input while item fields are typed, so `===` would never match.
    toArray(list).find((item) => readPath(item, String(field)) == value) ?? null
parser.functions.keys = (obj: unknown) =>
    obj != null && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : []
parser.functions.values = (obj: unknown) =>
    obj != null && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj) : []
parser.functions.to_json = (val: unknown) => {
    if (val == null) return ''
    // Checked before JSON.stringify rather than after, so a pathologically
    // large value fails without paying for the full serialization first.
    // `measureSize`'s own `cap` is a fixed early-exit hint (bounding the cost
    // of measuring one absurdly large value); the amount actually charged
    // against the shared per-evaluation tracker is what determines whether
    // this call — combined with everything already charged this evaluation
    // — is accepted.
    const cost = measureSize({ value: val, cap: FORMULA_MAX_JSON_VALUE_BUDGET })
    if (chargeSharedBudget({ tracker: currentJsonValueBudget, amount: cost })) {
        throw new FormulaSizeLimitError('Value is too large to convert to JSON')
    }
    return JSON.stringify(val)
}
parser.functions.from_json = (text: unknown) => {
    const str = String(text ?? '')
    if (chargeSharedBudget({ tracker: currentJsonValueBudget, amount: str.length })) {
        throw new FormulaSizeLimitError('JSON text is too large to parse')
    }
    try {
        return JSON.parse(str)
    }
    catch {
        return null
    }
}
parser.functions.build_object = (...args: unknown[]) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i + 1 < args.length; i += 2) {
        const key = String(args[i])
        // build_object writes a user-supplied key into a real object (a write sink,
        // unlike the read-only field helpers), so block prototype-mutating keys.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
        obj[key] = args[i + 1]
    }
    return obj
}
parser.functions.join_list = (list: unknown, sep: unknown = ',') => {
    const arr = toArray(list)
    const sepStr = String(sep)
    // Same multiplicative-output risk as replace(): a large array of small
    // elements (e.g. from split_text_to_list(x; "") — one element per
    // character of x) joined with a large separator builds a result far
    // bigger than either input alone. Projected before the real `.join()`,
    // and charged against the shared per-evaluation tracker so chaining
    // many join_list() calls can't each get a fresh allowance.
    //
    // Elements are stringified HERE, once, rather than inside the projection
    // — `.join()` below then runs on an already-all-string array and never
    // re-stringifies, so a large nested/object element is only ever
    // converted to a string once, not twice. `item ?? ''` matches
    // `Array.prototype.join`'s treatment of null/undefined as empty string
    // (`String(null)` would wrongly produce the literal text "null").
    const stringified = arr.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
    const projected = projectedJoinLength({ items: stringified, sep: sepStr })
    if (chargeSharedBudget({ tracker: currentBuiltStringBudget, amount: projected })) {
        throw new FormulaSizeLimitError('Result of join_list() is too large to build')
    }
    return stringified.join(sepStr)
}
parser.functions.first_item = (list: unknown) => toArray(list)[0]
parser.functions.last_item = (list: unknown) => {
    const arr = toArray(list)
    return arr[arr.length - 1]
}
parser.functions.item_at = (list: unknown, idx: unknown) =>
    toArray(list)[Number(idx)]
parser.functions.count = (list: unknown) => toArray(list).length
parser.functions.sum = (list: unknown, field: unknown) => {
    return toArray(list).reduce<number>((acc, item) => {
        const v =
            typeof item === 'object' && item !== null
                ? Number((item as Record<string, unknown>)[String(field)])
                : 0
        return acc + (isNaN(v) ? 0 : v)
    }, 0)
}
parser.functions.average = (list: unknown, field: unknown) => {
    const arr = toArray(list)
    if (!arr.length) return 0
    const total = arr.reduce<number>((acc, item) => {
        const v =
            typeof item === 'object' && item !== null
                ? Number((item as Record<string, unknown>)[String(field)])
                : 0
        return acc + (isNaN(v) ? 0 : v)
    }, 0)
    return total / arr.length
}
parser.functions.max_in_list = (list: unknown, field: unknown) => {
    const nums = toNumericFieldValues(list, field)
    return nums.length === 0 ? null : Math.max(...nums)
}
parser.functions.min_in_list = (list: unknown, field: unknown) => {
    const nums = toNumericFieldValues(list, field)
    return nums.length === 0 ? null : Math.min(...nums)
}
parser.functions.deduplicate = (list: unknown, field: unknown) => {
    const seen = new Set<unknown>()
    return toArray(list).filter((item) => {
        const key =
            typeof item === 'object' && item !== null
                ? (item as Record<string, unknown>)[String(field)]
                : item
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}
parser.functions.flatten = (list: unknown) => toArray(list).flat()
parser.functions.split_text_to_list = (s: unknown, sep: unknown = ',') =>
    String(s ?? '').split(String(sep)).map((x) => x.trim())

// `if` intentionally NOT registered as a JS function. Eager arg evaluation
// would break short-circuit semantics (e.g. `if(is_empty(x); "safe"; divide(x; 0))`
// would throw when x is empty). `rewriteLazyIf` transforms `if(c; a; b)` into
// expr-eval's lazy ternary `((c) ? (a) : (b))` before evaluation.
parser.functions.if_empty = (val: unknown, fallback: unknown) =>
    val === '' || val == null || val === 'undefined' ? fallback : val
parser.functions.if_null = (val: unknown, fallback: unknown) =>
    val == null || val === 'undefined' ? fallback : val
parser.functions.switch = (...args: unknown[]) => {
    const [val, ...pairs] = args
    for (let i = 0; i + 1 < pairs.length; i += 2) {
        if (pairs[i] == val) return pairs[i + 1]
    }
    return pairs.length % 2 === 1 ? pairs[pairs.length - 1] : ''
}
parser.functions.is_empty = (val: unknown) => val === '' || val == null
parser.functions.is_not_empty = (val: unknown) => val !== '' && val != null
parser.functions.is_equal = (a: unknown, b: unknown) => a == b
// and/or/not are reserved operators in expr-eval — register under prefixed names
// and normalizeExpression() rewrites them in the expression before evaluation
parser.functions.ap_and = (a: unknown, b: unknown) => Boolean(a) && Boolean(b)
parser.functions.ap_or = (a: unknown, b: unknown) => Boolean(a) || Boolean(b)
parser.functions.ap_not = (a: unknown) => !a
parser.functions.coalesce = (...args: unknown[]) =>
    args.find((a) => a !== '' && a != null) ?? ''

// After every impl is registered above, wrap any function whose registry entry
// declares `argCompatibility.defaultArgs` so older saved flows that were saved
// before a new arg was added keep working at runtime instead of throwing a
// "wrong number of arguments" error.
for (const fn of AP_FUNCTIONS) {
    const defaults = fn.argCompatibility?.defaultArgs
    if (!defaults || defaults.length === 0) continue
    const impl = parser.functions[fn.name] as ((...args: unknown[]) => unknown) | undefined
    if (!impl) continue
    parser.functions[fn.name] = (...args: unknown[]) => {
        const padded = [...args]
        for (let i = padded.length; i < fn.minArgs; i++) {
            padded.push(defaults[i - args.length] ?? defaults[defaults.length - 1])
        }
        return impl(...padded)
    }
}

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value
    if (value == null) return []
    return [value]
}

function readField(item: unknown, field: string): unknown {
    if (item !== null && typeof item === 'object') {
        return (item as Record<string, unknown>)[field]
    }
    return undefined
}

// Traverse a dot-separated path (e.g. "output.body.s3_key") so pluck/find_by can
// reach nested step outputs. A path with no dots behaves like a single-level read.
function readPath(item: unknown, path: string): unknown {
    // A literal key that itself contains dots (common in webhook/analytics
    // payloads like {"user.email": ...}) wins over traversal, so adding dot-path
    // support stays backward compatible with flat single-level reads.
    if (item != null && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, path)) {
        return (item as Record<string, unknown>)[path]
    }
    let value = item
    for (const part of path.split('.')) {
        if (value == null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[part]
    }
    return value
}

// `in` accepts either a real list (e.g. from split_text_to_list or pluck) or a
// comma-separated string, so `.pdf OR .docx` filtering needs no CODE step.
function toValueList(value: unknown): unknown[] {
    if (Array.isArray(value)) return value
    return String(value ?? '').split(',').map((part) => part.trim())
}

function matchesOperator(fieldValue: unknown, value: unknown, operator: string): boolean {
    switch (operator) {
        case 'not_equals': return fieldValue != value
        case 'contains': return String(fieldValue ?? '').includes(String(value ?? ''))
        case 'starts_with': return String(fieldValue ?? '').startsWith(String(value ?? ''))
        case 'ends_with': return String(fieldValue ?? '').endsWith(String(value ?? ''))
        case 'greater_than': return Number(fieldValue) > Number(value)
        case 'less_than': return Number(fieldValue) < Number(value)
        case 'in': return toValueList(value).some((candidate) => candidate == fieldValue)
        case 'equals':
        default: return fieldValue == value
    }
}

function toNumericFieldValues(list: unknown, field: unknown): number[] {
    const fieldName = String(field)
    const result: number[] = []
    for (const item of toArray(list)) {
        const raw = readField(item, fieldName)
        if (raw == null) continue
        const num = Number(raw)
        if (Number.isFinite(num)) result.push(num)
    }
    return result
}

// Counts non-overlapping matches the same way `String.prototype.split` would
// — via `.indexOf` scanning, not `.split` itself, so counting never
// materialises the array of parts.
function countOccurrences({ haystack, needle }: { haystack: string, needle: string }): number {
    let count = 0
    let fromIndex = 0
    while (true) {
        const idx = haystack.indexOf(needle, fromIndex)
        if (idx === -1) return count
        count += 1
        fromIndex = idx + needle.length
    }
}

// Predicts the length `source.split(from).join(to)` would produce, without
// running it. `split('')` is a special case: it yields one part per
// character (not `|source| + 1`), so it's handled separately from the
// general `split(from)` case, which yields `occurrences + 1` parts.
function projectedSplitJoinLength({ source, from, to }: { source: string, from: string, to: string }): number {
    if (from === '') {
        return source.length + Math.max(0, source.length - 1) * to.length
    }
    const occurrences = countOccurrences({ haystack: source, needle: from })
    return source.length + occurrences * (to.length - from.length)
}

// Predicts the length `items.join(sep)` would produce. Takes already-
// stringified items — the caller stringifies once and reuses the result for
// both this measurement and the real join, rather than this function
// stringifying its own throwaway copy.
function projectedJoinLength({ items, sep }: { items: string[], sep: string }): number {
    let total = sep.length * Math.max(0, items.length - 1)
    for (const item of items) {
        total += item.length
    }
    return total
}

export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

import dayjs from 'dayjs'
import relativeTimeDayjs from 'dayjs/plugin/relativeTime'
import timezoneDayjs from 'dayjs/plugin/timezone'
import utcDayjs from 'dayjs/plugin/utc'
import { Parser } from 'expr-eval'
import { FORMULA_MAX_BUILT_STRING_LENGTH, FORMULA_MAX_JSON_VALUE_BUDGET, FormulaSecurityError, FormulaSizeLimitError, measureSize } from './formula-bounds'
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
        // Not declared in expr-eval's own .d.ts at all (only `functions: any`
        // is) — added here so overriding `binaryOps['||']` below doesn't need
        // a cast. Deliberately NOT a uniform `Record<string, (a, b) => unknown>`:
        // expr-eval's binary operators do not all share one shape (`=` is
        // 3-arg `setVar(name, value, variables)`, `[` is `arrayIndex(array,
        // index)` — neither is a 2-arg `(a, b)` function). A uniform 2-arg
        // record would let a future edit assign a wrong-arity function to
        // `binaryOps['=']` or `binaryOps['[']` and still type-check, silently
        // breaking assignment or array-index evaluation. Only `||` — the one
        // key this module actually reads/writes — gets a real signature;
        // every other key is `unknown`, forcing a type guard before anyone
        // touches one.
        binaryOps: { '||': (a: unknown, b: unknown) => unknown, [key: string]: unknown }
    }
    // `Expression.tokens` (the parsed instruction array) is not part of
    // expr-eval's published `.d.ts` either — `Expression` there declares
    // only `simplify`/`evaluate`/`substitute`/`symbols`/`variables`/
    // `toJSFunction`. Added so `findForbiddenMemberAccess` below can walk
    // the real parsed structure instead of grepping the source text (see
    // that function's comment for why a text-level check doesn't work).
    // `ExprEvalInstruction` (defined at the bottom of this file) is a
    // minimal, locally-defined shape — expr-eval doesn't export an
    // `Instruction` type either. `evaluate` here is an ADDITIONAL overload
    // (methods merge as overloads, unlike the plain-property case above —
    // this doesn't hit the "must match exactly" restriction), widening the
    // same way `Parser.evaluate` already does above, since `evaluateRaw`
    // now calls `parser.parse(expression).evaluate(vars)` directly instead
    // of the one-shot `parser.evaluate(expression, vars)`.
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Expression {
        tokens: ExprEvalInstruction[]
        evaluate(values: Record<string, unknown>): unknown
    }
}

// Parser is a module-private singleton — exposing it would let any consumer
// of @aiqadam/shared mutate `parser.functions.X` and break formula
// evaluation process-wide. Use `evaluateRaw` instead.
//
// `operators.fndef` disables expr-eval's `()=` function-definition operator
// (`f(x) = x*x` / `map(f(x) = x*x, [1,2,3])`) via a switch expr-eval already
// supports through its own constructor options — no need to delete or wrap
// anything post-hoc. Zero documented Qadam Flow formula uses it: none of the
// 87 examples in function-registry.ts, no entry in the web function picker,
// no mention in the docs. It is a side effect of embedding this library, and
// it is a second, independent path to `Function`'s constructor — the
// callee's scope for a defined function is built with `Object.assign({},
// values)` inside expr-eval's own `IFUNDEF` handling, a fresh object this
// module never gets a chance to touch. Disabling it here removes that path
// outright rather than trying to guard what runs inside it.
const parser = new Parser({ operators: { fndef: false } })

// Snapshot of exactly what expr-eval registers on `parser.functions` before
// this module touches it — used at the end of this file to sweep away every
// built-in we never asked for (see the comment there for why). Captured by
// reference, not by value: comparing `parser.functions[key] ===
// builtInFunctionsSnapshot[key]` later tells us whether THIS key still
// points at the untouched original implementation ("we never wanted this,
// remove it") or was reassigned to one of ours, including the two cases
// where we override a built-in `parser.functions` entry under its OWN name
// (`min`/`max` below — `length` is NOT one of these: expr-eval's `length`
// lives in `unaryOps`, a different table this sweep never touches, so
// `parser.functions.length` below is a brand-new key, not an override) —
// reassignment always produces a new function reference, so identity
// comparison catches both "brand new key" and "we replaced this one" the
// same way, with no separate hand-maintained list of our own function names
// that could drift out of sync with the registrations below.
const builtInFunctionsSnapshot: Record<string, unknown> = { ...parser.functions }

// A per-call cap on each size-generating function (replace/join_list/
// to_json/from_json/split_text_to_list) is not enough: every call gets a
// FRESH allowance, so chaining N individually-capped calls together (e.g.
// via suffix()/combine(), which are themselves unguarded concatenation, or
// by nesting split_text_to_list() inside itself) can still produce N times
// (or, when nesting doubles per level, exponentially more than) the intended
// ceiling — the exact defect class rejected in earlier review rounds. These
// two mutable trackers are shared by every guarded function call within ONE
// evaluateRaw() invocation, so the SUM of what they've each produced is
// what's bounded, not each call in isolation.
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
//
// INVARIANT the whole design rests on: no `await` may EVER appear between
// setting these two trackers and the `finally` block below clearing them —
// not in evaluateRaw, not in anything it calls. This function is synchronous
// today (`parser.evaluate` is synchronous and none of the guarded functions
// are async), so nothing yields between "set the tracker" and "clear the
// tracker".
//
// A PRIOR version of this comment claimed a missing `finally` would leave a
// stale, exhausted tracker in place and "silently fail every later
// evaluation" — that claim was checked against the code and found false:
// the two assignments at the top of evaluateRaw ran UNCONDITIONALLY on every
// call regardless of the previous call's outcome, so a rejected evaluation
// self-healed the very next time evaluateRaw ran, and a test asserting "the
// next evaluation still succeeds" passed even with the `finally` deleted
// entirely. The real (and, before this fix, unobservable) risk was
// concurrent/re-entrant calls: if evaluateRaw were ever made `async`, a
// SECOND call starting while a FIRST is still mid-`await` would overwrite
// both module-level trackers, and when the first call's `finally` (or lack
// of one) ran, it could null out the SECOND call's still-in-progress
// tracker — corrupting whichever evaluation is still running, not the next
// one to start.
//
// That risk is now a hard assertion instead of a comment: entry asserts
// both trackers are `null` (i.e. no other evaluation is in flight) rather
// than unconditionally overwriting them. This trades away something real —
// evaluateRaw can no longer be called re-entrantly (e.g. a hypothetical
// future "evaluate a sub-formula from within a formula function" feature)
// without first reworking these two nullable slots into a stack. There is
// no such re-entrant call today, so the assertion costs nothing yet, but it
// is a real constraint on future design, not a free improvement. In
// exchange, a missing/misplaced `finally` now fails the very NEXT
// evaluation, loudly, with a distinct error — see the
// `formula-evaluator budget: a rejected evaluation does not poison the next
// one` test, which now genuinely exercises this (confirmed by temporarily
// removing the `finally` and watching it fail before restoring it).
let currentBuiltStringBudget: { remaining: number } | null = null
let currentJsonValueBudget: { remaining: number } | null = null

export function evaluateRaw(expression: string, vars: Record<string, unknown>): unknown {
    if (currentBuiltStringBudget !== null || currentJsonValueBudget !== null) {
        // Not a formula error — a bug in evaluateRaw's own bookkeeping (a
        // missing/misplaced `finally`, or genuine re-entrancy this design
        // does not support). It is still a plain `Error`, not a
        // `FormulaSizeLimitError`, so evaluateSingleFormula's catch does NOT
        // treat it specially — it falls through to friendlyError's generic
        // fallback, and the user sees the same "Could not evaluate this
        // formula" as any other unhandled error. What throwing here DOES
        // buy is not surfacing to the USER differently — it's that it fails
        // on THIS evaluation instead of silently corrupting the tracker for
        // whichever evaluation runs next, and the thrown message itself
        // (visible in logs/stack traces) names the actual bug rather than
        // whatever guarded function happened to run first and hit a
        // pre-exhausted budget.
        throw new Error('evaluateRaw invoked while a previous evaluation\'s budget tracker was still set')
    }
    currentBuiltStringBudget = { remaining: FORMULA_MAX_BUILT_STRING_LENGTH }
    currentJsonValueBudget = { remaining: FORMULA_MAX_JSON_VALUE_BUDGET }
    try {
        // Parsed once, then checked, then evaluated — rather than
        // `parser.evaluate(expression, vars)` in one call — so
        // `findForbiddenMemberAccess` can reject a dangerous member name
        // before a single guarded function, operator, or user callback
        // runs. See that function's comment for why this walks the parsed
        // instruction tree instead of the raw text.
        const parsed = parser.parse(expression)
        const forbiddenMember = findForbiddenMemberAccess(parsed.tokens)
        if (forbiddenMember !== null) {
            throw new FormulaSecurityError(`Formula cannot access ".${forbiddenMember}" — this property name is not allowed`)
        }
        return parsed.evaluate(vars)
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

// Every size guard above lives on `parser.functions.*` — but `||` (string/
// array concatenation) is a built-in expr-eval BINARY OPERATOR, evaluated
// inside expr-eval's own engine and never touching a registered function at
// all. Combined with `=` (assignment) — `(a = v||v) || (b = a||a) ||
// (c = b||b) || ...` — each step assigns the DOUBLED value to a short
// variable name and reuses that name, so the expression TEXT grows by a
// small constant per step while the VALUE doubles: verified against the real
// `expr-eval@2.0.2` dependency, a 1000-char seed run through 3 such steps
// (an ~40-character expression) produces a 14,000-character result, and a
// 290-character expression at depth 16 produced a 131,070,000-character
// result with no error.
//
// `||` was previously believed to be the ONLY such primitive, reasoning that
// `+`/`-` are numeric-only and every other operator selects or stores rather
// than concatenates. That reasoning was correct about the OPERATORS but
// incomplete: it did not extend to `parser.functions` (expr-eval registers
// its own built-ins there too — `join`, `map`, `fold`, `filter`, `indexOf`,
// among others — completely independent of the operator table), one of
// which (`join`) is strictly worse than `||` (see the allowlist sweep after
// the registration block below for the measured numbers) and needed a
// different fix entirely: removal, not a guard, since `map`/`fold`/`filter`
// are compute-bound (they invoke a callback per element) rather than
// allocation-bound, and no size budget stops a slow loop. `||` still needs
// its OWN guard here regardless of the sweep below, because it is a
// BINARY OPERATOR, not a `parser.functions` entry — the sweep cannot reach
// it.
const builtInConcat = parser.binaryOps['||']
// Fails at MODULE LOAD, not per-formula, if a future expr-eval version
// renames or drops this operator — the alternative (capturing `undefined`
// silently) would make every single `||` in every formula throw a bare
// TypeError from inside `concat()`, surfacing to users as the generic
// "Could not evaluate this formula" with no hint that the guard itself is
// broken.
if (typeof builtInConcat !== 'function') {
    throw new Error('expr-eval no longer registers a "||" binary operator — the formula concatenation size guard cannot be installed')
}
parser.binaryOps['||'] = (a: unknown, b: unknown) => {
    const result = builtInConcat(a, b)
    const amount = typeof result === 'string' || Array.isArray(result) ? result.length : 0
    if (chargeSharedBudget({ tracker: currentBuiltStringBudget, amount })) {
        throw new FormulaSizeLimitError('Result of || is too large to build')
    }
    return result
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
parser.functions.split_text_to_list = (s: unknown, sep: unknown = ',') => {
    // `String(arr)` joins an array argument with ',' — nesting this call
    // (feeding one call's array output back in as the next call's `s`)
    // round-trips array -> comma-joined string -> array-of-chars each level,
    // roughly DOUBLING length per nesting level (n chars become ~2n-1 once
    // the join adds n-1 commas, which then themselves become individual
    // elements on the next split). ~24 characters of expression text per
    // level reaches multi-gigabyte well inside the 200 KB expression cap,
    // and nothing charged it before: the built-string budget covered only
    // replace()/join_list(). Charged here the same way, against the shared
    // per-evaluation tracker, so nesting can't compound past the shared
    // budget even though any single level's own array output looks modest.
    const str = String(s ?? '')
    if (chargeSharedBudget({ tracker: currentBuiltStringBudget, amount: str.length })) {
        throw new FormulaSizeLimitError('Result of split_text_to_list() is too large to build')
    }
    return str.split(String(sep)).map((x) => x.trim())
}

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

// Guarding size-generating `parser.functions` entries one at a time took
// four review rounds to reach `replace`/`join_list`/`to_json`/`from_json`/
// `split_text_to_list` and still missed expr-eval's OWN built-ins. A fresh
// `new Parser().functions` registers exactly 16 keys; this module's
// registrations above override only 2 of them (`min`, `max`) under their own
// names, so the sweep below removes the other 14: `random`, `fac`, `hypot`,
// `pyt`, `pow`, `atan2`, `if`, `gamma`, `roundTo`, `map`, `fold`, `filter`,
// `indexOf`, `join`. Measured directly against the real `expr-eval@2.0.2`
// dependency: nesting `join(sep, array)` four levels deep over 100-element
// array literals (`join(join(join(join("aaaaaaaaaa",[0,1,...,99]),
// [0,1,...,99]),[0,1,...,99]),[0,1,...,29])`) — a 994-character expression,
// zero input data — built a 335,941,270-character string, +333MB RSS, in
// 138ms. Worse, and NOT fixable by any size budget: `map`/`fold`/`filter`
// invoke a callback PER ELEMENT (expr-eval's `()=` function-definition
// operator makes an inline callback expression), so nested `map`s over a
// few hundred elements each is tens of millions of callback invocations —
// that is compute time, not allocation, and a byte-counting guard cannot
// see it coming.
//
// `if` needs its own note: it IS one of ours — `AP_FUNCTIONS` documents a
// 3-argument `if(condition; true_value; false_value)` and the web function
// picker renders it — but it is never registered as `parser.functions.if`.
// `rewriteLazyIf` (formula-evaluator.ts) rewrites every 3-arg `if(c;a;b)`
// into a ternary `((c)?(a):(b))` before the expression reaches this file, so
// the literal name "if" never survives to be looked up here for a VALID
// call. This sweep removing expr-eval's built-in `if` (a 3-arg eager
// conditional, distinct from our lazy-ternary rewrite) changes behaviour
// only for INVALID arities: a 2-arg or 4-arg `if(...)` — already outside
// `AP_FUNCTIONS`'s declared `minArgs: 3, maxArgs: 3` — previously fell
// through rewriteLazyIf's `else` branch un-rewritten, reached expr-eval's
// built-in `if`, and silently returned a value; it now errors instead. That
// is arguably a correctness fix (an already-invalid call now fails instead
// of silently doing something), but it is a real, disclosed behaviour
// change, not a no-op.
//
// This replaces per-function enumeration with an allowlist: after every
// intentional registration above, delete every `parser.functions` key that
// still points at its ORIGINAL expr-eval implementation (see
// `builtInFunctionsSnapshot` below `const parser = new Parser()`, which it
// must be — it snapshots THIS instance's `.functions` object, so it cannot
// be captured before the instance exists). Anything we registered — new or
// overriding a built-in under its own name — has a different reference by
// now and survives. A future expr-eval version adding another built-in is
// excluded by default instead of silently reopening this exact hole, and
// removing `map`/`fold`/`filter` this way closes the compute-bound risk
// completely: there is no callback to invoke if the function does not exist.
//
// Latent footgun, not present today: this relies on every one of OUR
// registrations producing a NEW function reference. Registering a built-in
// verbatim under its own name — `parser.functions.min = min` using the
// SAME imported `min`, rather than a fresh arrow wrapping it — would leave
// the reference identical to the snapshot and get silently swept away. Both
// `min` and `max` above are fresh arrows (`(a, b) => Math.min(...)`), not
// re-exports of anything expr-eval defines, so this does not happen today —
// but it is a real constraint on how future overrides must be written, not
// an impossible case.
for (const key of Object.keys(parser.functions)) {
    if (parser.functions[key] === builtInFunctionsSnapshot[key]) {
        // `Reflect.deleteProperty` returns `false` (no throw) instead of
        // deleting a non-configurable property. Checked, not discarded: a
        // future expr-eval version registering its built-ins via
        // `Object.defineProperty(..., { configurable: false })` or as
        // accessors would make this silently no-op per key — reopening the
        // exact hole this sweep exists to close, with zero signal. Same
        // fail-loud shape as the `builtInConcat` module-load guard above.
        if (!Reflect.deleteProperty(parser.functions, key)) {
            throw new Error(`Could not remove the expr-eval built-in "${key}" from parser.functions — it may be non-configurable, which would silently defeat the allowlist sweep`)
        }
    }
}

// RCE FIX (this section) + KNOWN OPEN GAP (still, deliberately, below) —
// read this before touching `Object.setPrototypeOf` on
// `functions`/`unaryOps`/`binaryOps`/`ternaryOps`/`consts`/`vars` again:
//
// A version of this file nulled the prototypes of all six of those, to
// close the gap described at the end of this comment. That change enabled
// remote code execution, confirmed with a working `child_process.execSync`
// payload against this evaluator, and was reverted. The mechanism:
// `unaryOps`/`binaryOps`/`ternaryOps` inheriting `Object.prototype` is not
// only a leak — it is ALSO an accidental parse-time barrier.
// `TokenStream.isNamedOp` tokenizes any identifier found in those three
// tables as an OPERATOR rather than a plain member name, and because
// `constructor` is inherited from `Object.prototype` on all three,
// `X.constructor` tokenizes as `X` followed by an operator and the parse
// dies. Null those three prototypes and `constructor` becomes an ORDINARY
// member name with no special handling, and (before the fix below)
// `IMEMBER` access was not filtered at all.
//
// The owner's decision was to close the actual hole with intent rather than
// rely on that accident: block the three dangerous member names outright
// (`findForbiddenMemberAccess`, checked in `evaluateRaw` against the parsed
// instruction tree before evaluation ever runs — see that function's
// comment for why a text-level check doesn't work), and separately disable
// expr-eval's `()=` function-definition operator via its own supported
// `operators.fndef` switch (see the `new Parser(...)` call above) — the
// second, independent path to `Function`'s constructor, through
// `evaluate()`'s `IFUNDEF` branch building its callee's scope with
// `Object.assign({}, values)`, a FRESH object this module never gets a
// chance to touch regardless of what `vars`'s own prototype is. Both RCE
// payloads below are pinned as regression tests in
// function-evaluator.test.ts, confirmed to no longer evaluate:
//   {{step_1.body}}.constructor.constructor("return 7")()
//   (g(y) = constructor.constructor("return 7")())(1)
// The accidental parse-time barrier (`isNamedOp` finding `constructor`
// through the intact prototypes) still exists underneath this — this fix
// adds a deliberate, intentional layer on top of it, and doesn't remove or
// depend on the accident continuing to hold.
//
// Direct member access to `.__proto__`/`.prototype` (without chaining
// `.constructor` afterward) was found, during this investigation, to
// ALREADY bypass the accidental barrier even before this fix —
// `x.__proto__` and `x.prototype` parsed and evaluated successfully on
// `main`, because `__proto__`/`prototype` are not both inherited by every
// one of the three operator tables the same way `constructor` is. Bracket
// notation (`x["constructor"]`) was checked too and is NOT an alternate
// property-access path: expr-eval's `[` is `arrayIndex(array, index)`,
// which coerces its operand to a number (`index | 0`) rather than doing a
// generic property lookup, so a string like `"constructor"` just becomes
// index `0`.
//
// STILL OPEN, unchanged by the above, and must not be described as closed:
// `Object.prototype` METHODS (`toString`, `hasOwnProperty`, `valueOf`, ...)
// remain callable as formula "functions" — `toString(1)` evaluates to the
// string "[object Undefined]" — because `functions`/`unaryOps`/`binaryOps`/
// `ternaryOps`/`consts`/`vars` all still inherit `Object.prototype`, and
// expr-eval resolves names against them with `in` or bracket access, which
// walks the whole chain. As far as two review passes could determine, this
// specific gap — a handful of harmless methods callable with an `undefined`
// receiver — is not itself exploitable, and is NOT closed by the
// member-name filter above (it filters `.name` access, not bare
// identifiers resolving to inherited methods). Nulling those six prototypes
// remains unsafe for the reason explained above; it stays open.

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

const FORBIDDEN_MEMBER_NAMES = new Set(['constructor', '__proto__', 'prototype'])

// `.constructor`/`.__proto__`/`.prototype` are the path to `Function`'s
// constructor and arbitrary code execution once member access reaches a
// live object (`x.constructor.constructor("return ...")()`). A text-level
// check (regex over the raw formula string) is NOT an option here:
// `wrapStringArgs`/`normalizeExpression` (formula-evaluator.ts) rewrite the
// string before it is ever parsed, so a check against the raw text inspects
// something other than what expr-eval actually runs — the exact class of
// bug a size-DoS guard in this same file was rejected for, twice, in
// earlier review rounds. Checked instead against the PARSED instruction
// tree (`Expression.tokens`, walked below), which is what `.evaluate()`
// itself runs — there is nothing left to rewrite by the time this runs.
//
// `IMEMBER` is expr-eval's instruction type for `.name` access; its
// `value` is the plain member-name string. `IEXPR` wraps a nested
// sub-array of instructions — used for ternary (`?:`) branches and (before
// this PR) function-definition bodies — and must be walked recursively, or
// `x ? y.constructor : 1` would slip through unchecked. Array-literal
// elements (`[a, b.constructor]`) do NOT need special handling: expr-eval
// pushes them flat into the same top-level array this function already
// scans, not into a nested one.
function findForbiddenMemberAccess(tokens: ExprEvalInstruction[]): string | null {
    for (const instruction of tokens) {
        if (
            instruction.type === 'IMEMBER' &&
            typeof instruction.value === 'string' &&
            FORBIDDEN_MEMBER_NAMES.has(instruction.value)
        ) {
            return instruction.value
        }
        if (instruction.type === 'IEXPR' && isInstructionArray(instruction.value)) {
            const nested = findForbiddenMemberAccess(instruction.value)
            if (nested !== null) return nested
        }
    }
    return null
}

function isInstructionArray(value: unknown): value is ExprEvalInstruction[] {
    return Array.isArray(value) && value.every(
        (item) => item !== null && typeof item === 'object' && 'type' in item && 'value' in item,
    )
}

export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// A minimal local shape for expr-eval's parsed `Instruction` — expr-eval
// doesn't export an `Instruction` type, only the string-tagged shape
// `{ type, value }` used throughout its own source. `value` is `unknown`
// because it varies by `type`: a plain string for `IMEMBER`/`IVAR`, a
// number for `INUMBER`, a nested `ExprEvalInstruction[]` for `IEXPR`, and
// other shapes for instruction types this file never inspects.
type ExprEvalInstruction = {
    type: string
    value: unknown
}

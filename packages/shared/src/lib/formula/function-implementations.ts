import dayjs from 'dayjs'
import relativeTimeDayjs from 'dayjs/plugin/relativeTime'
import timezoneDayjs from 'dayjs/plugin/timezone'
import utcDayjs from 'dayjs/plugin/utc'
import { Parser } from 'expr-eval-fork'
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
declare module 'expr-eval-fork' {
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
        // Not in expr-eval's own `.d.ts` either. `findSecurityViolation` reads
        // this only to test own-key membership (`Object.hasOwn`) of operator
        // names, and the S2 guard loop re-assigns each callable entry wrapped;
        // nothing here invokes an entry, so `unknown` values are enough.
        ternaryOps: Record<string, unknown>
    }
    // `Expression.tokens` (the parsed instruction array) is not part of
    // expr-eval's published `.d.ts` either — `Expression` there declares
    // only `simplify`/`evaluate`/`substitute`/`symbols`/`variables`/
    // `toJSFunction`. Added so `findSecurityViolation` below can walk
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
// remove it") or was reassigned to one of ours, including the three cases
// where we override a built-in `parser.functions` entry under its OWN name
// (`min`/`max`/`sum` below — `length` is NOT one of these: expr-eval's `length`
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
// Objects already known to hold no function at any depth, for THIS
// evaluation: everything the plain-data scope conversion produced, plus every
// object `assertHoldsNoFunction` has walked. Lets the per-call checks skip a
// scope value that is merely passed along (a large list handed to
// `filter_list`, then to `count`) instead of re-walking it on every step.
// Same lifetime and same re-entrancy constraint as the two budgets above.
let currentVerifiedPlainData: WeakSet<object> | null = null

export function evaluateRaw(expression: string, vars: Record<string, unknown>): unknown {
    if (currentBuiltStringBudget !== null || currentJsonValueBudget !== null || currentVerifiedPlainData !== null) {
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
    currentVerifiedPlainData = new WeakSet()
    try {
        // Parsed once, then checked, then evaluated — rather than
        // `parser.evaluate(expression, vars)` in one call — so
        // `findSecurityViolation` can reject a forbidden name before a single
        // guarded function or operator runs. See that function's comment for
        // why this walks the parsed instruction tree instead of the raw text.
        const parsed = parser.parse(expression)
        const violation = findSecurityViolation(parsed.tokens)
        if (violation !== null) {
            throw new FormulaSecurityError(violation)
        }
        // The formula reads a plain-data copy of the caller's scope, never the
        // caller's objects (see `toPlainDataScope`): own enumerable properties
        // only, JSON-shaped values only, no functions at any depth, and a
        // null-prototype root so the last step of the library's identifier
        // resolution (`values[name]`) finds own keys only. The result is held
        // to the same rule as every function and operator result (S2 in the
        // RUNTIME DATA INVARIANTS comment below).
        return assertHoldsNoFunction(parsed.evaluate(toPlainDataScope(vars)))
    }
    finally {
        currentBuiltStringBudget = null
        currentJsonValueBudget = null
        currentVerifiedPlainData = null
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
// small constant per step while the VALUE doubles: verified against upstream
// `expr-eval@2.0.2` (the fork's `||` is unchanged), a 1000-char seed run
// through 3 such steps (an ~40-character expression) produces a
// 14,000-character result, and a
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
        const v = Number(readField(item, String(field)))
        return acc + (isNaN(v) ? 0 : v)
    }, 0)
}
parser.functions.average = (list: unknown, field: unknown) => {
    const arr = toArray(list)
    if (!arr.length) return 0
    const total = arr.reduce<number>((acc, item) => {
        const v = Number(readField(item, String(field)))
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
                ? readField(item, String(field))
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
// `new Parser().functions` (expr-eval-fork@3.0.3) registers exactly 17 keys;
// this module's registrations above override 3 of them (`min`, `max`, `sum`)
// under their own names, so the sweep below removes the other 14: `random`,
// `fac`, `hypot`, `pyt`, `pow`, `atan2`, `if`, `gamma`, `roundTo`, `map`,
// `fold`, `filter`, `indexOf`, `join`. Measured directly against upstream
// `expr-eval@2.0.2` (the fork's `join` is unchanged): nesting
// `join(sep, array)` four levels deep over 100-element array literals (`join(join(join(join("aaaaaaaaaa",[0,1,...,99]),
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

// RUNTIME DATA INVARIANTS — what this module guarantees about the values a
// formula evaluates over, and how. Read this before touching `evaluateRaw`,
// `toPlainDataScope`, `assertHoldsNoFunction`, the guard loop below or
// `Object.setPrototypeOf` on any expr-eval table.
//
// `expr-eval-fork` carries the upstream fixes for the two `evaluate()`
// advisories: at a call (`IFUNCALL`) it refuses any callee that is not an
// entry of `parser.functions` (or an own value of a scope object that is a
// `Math` function or such an entry), and it refuses `__proto__`/`prototype`/
// `constructor` names at evaluation time with a loose pattern that also
// rejects names merely containing "prototype", ending in "constructor" or
// starting with "__proto__" (e.g. a `my_prototype_id` key read with `.member`
// syntax). The library pushes a function onto its own value stack in places
// this module cannot intercept — a bare identifier naming a registered
// function or a unary operator, and a `.member` read off a primitive
// (`"a".at`) or off another function — so this module does NOT try to track
// where function values are on that stack. It constrains the DATA instead:
//
// S1. THE SCOPE IS PLAIN DATA. `evaluateRaw` evaluates against a copy of the
//    caller's scope built by `toPlainDataScope`: own enumerable string keys
//    only, JSON semantics (`toJSON` honoured, so a `Date` becomes its ISO
//    string; functions, symbols, `undefined`, `bigint` dropped from objects
//    and read as `null` in arrays and at the root; non-finite numbers become
//    `null`; class instances flatten to their own enumerable properties),
//    plain objects and arrays with a null-prototype root. The formula never
//    touches the caller's objects and no function exists anywhere in its
//    scope. Consequently the library's "own value of a scope object" callee
//    allowance above can never match, so the only callable things are entries
//    of `parser.functions`.
//
// S2. NOTHING THAT CROSSES A FUNCTION OR OPERATOR BOUNDARY HOLDS A FUNCTION.
//    Every entry of `parser.functions`, `parser.unaryOps`, `parser.binaryOps`
//    and `parser.ternaryOps` is wrapped (the loop below) so each argument it
//    receives and the value it returns is walked by `assertHoldsNoFunction`
//    — own enumerable keys, array elements, cycle-safe, cached per evaluation
//    — and a function at any depth throws `FormulaSecurityError`. The final
//    result of the evaluation is held to the same rule in `evaluateRaw`. So a
//    function value the library puts on its stack can only be: discarded
//    (`IENDSTATEMENT`), read with `.member` (yielding another function, a
//    string or a number — with the names in D3a refused), or offered as a
//    callee, where the library's allowlist applies. It cannot be stored in a
//    variable (`=` is a binary operator), placed in a value a function or
//    operator builds, or returned. Scope data holds no function to begin with
//    (S1), so with S2 nothing a formula can name, build or return does.
//    The library treats an object whose `type` field is its internal
//    deferred-expression tag as an expression to run; because no
//    formula-reachable value holds a function, that path can only throw a
//    type error, never run anything.
//
// The pre-evaluation pass (`findSecurityViolation`) and the table hardening
// below are independent of S1/S2 and are kept:
//
// D2. OWN-PROPERTY-ONLY RESOLUTION. The library resolves a bare identifier
//    (`IVAR`) as `name in expr.functions`, then `name in expr.unaryOps`, then
//    `values[name]` — and `in` walks the prototype chain. Each table on that
//    path is covered separately, because they cannot all be handled the same
//    way:
//    - `parser.functions` and `parser.consts` are null-prototyped below;
//    - the scope root built by `toPlainDataScope` is null-prototyped;
//    - `parser.unaryOps` is NOT null-prototyped (see below), so the gate
//      instead refuses any identifier `unaryOps` would only find through its
//      prototype (`isInheritedIdentifier`).
//    `resolveVariable` (formula-evaluator.ts) and `readField`/`readPath`
//    below apply the same own-property rule to the data paths they walk.
//
// D3a. FORBIDDEN NAMES. `constructor`/`__proto__`/`prototype` are rejected as
//    `IMEMBER` access, as bare `IVAR` identifiers and as `IVARNAME` assignment
//    targets, walking into nested `IEXPR` branches (ternary / `and` / `or` /
//    assignment right-hand sides). Independent of the library's own pattern.
//
// D3b. OPERATOR OWN-KEY. An operator (`IOP1`/`IOP2`/`IOP3`) must be an OWN key
//    of its operator table. The operator tables keep `Object.prototype`, so an
//    inherited name used in the unary-operator call form would otherwise
//    resolve and run.
//
// D4. `operators.fndef: false` (the `new Parser(...)` call above) removes the
//    library's `()=` function-definition operator — the one way a formula
//    could define a function body — with the `IFUNDEF` gate branch as backstop.
//
// Never call `Expression.toJSFunction`: it compiles the expression with
// `new Function()` and is the subject of an advisory the fork does not
// address. Nothing here uses it; `no-restricted-properties` in this
// package's `eslint.config.mjs` keeps it that way, and a test stubs it to throw.
//
// Why NOT null the operator tables (`unaryOps`/`binaryOps`/`ternaryOps`):
// their inherited `Object.prototype` is also an accidental parse-time barrier
// (`TokenStream.isNamedOp` tokenizes `constructor`, found there through the
// prototype, as an operator so `x.constructor` fails to parse). Invariant:
// the operator tables keep `Object.prototype` and are checked by own-key, so
// that parse barrier stays in place in addition to D3a. Bracket notation
// (`x["name"]`) is not a property-access path either: the library's `[` is
// `arrayIndex`, coercing its operand to a number.

// Own-property-only identifier resolution (D2): a bare identifier can no
// longer walk the prototype chain of these two tables.
// Done AFTER every registration and the allowlist sweep so own keys are intact.
Object.setPrototypeOf(parser.functions, null)
Object.setPrototypeOf(parser.consts, null)

// S2: wrap every function and operator the library can invoke. Installed
// LAST — after every registration, the `||` size guard, the default-argument
// padding and the allowlist sweep — so the guard is the outermost layer on
// every entry and no later registration can slip in unwrapped. The sweep
// above compares identities against `builtInFunctionsSnapshot`, so it must
// run before this loop changes them. The `||` guard, `isOwnOperator` and
// `isInheritedIdentifier` only look keys up by name, so they are unaffected.
const guardedTables: Record<string, unknown>[] = [parser.functions, parser.unaryOps, parser.binaryOps, parser.ternaryOps]
for (const table of guardedTables) {
    for (const key of Object.keys(table)) {
        const impl = table[key]
        if (isCallable(impl)) {
            table[key] = guardPlainData(impl)
        }
    }
}

// S1 (see RUNTIME DATA INVARIANTS above). Builds the scope a formula reads:
// a null-prototype root whose values are plain-data copies of the caller's
// values, converted once per evaluation. A root entry whose value is not
// plain data (a function, a symbol) reads as `null` rather than disappearing,
// so the variable still exists and `{{x}}` behaves like a missing value
// instead of an unknown identifier. Every object this produces is recorded in
// `currentVerifiedPlainData`, so the S2 checks never walk scope data twice.
function toPlainDataScope(vars: Record<string, unknown>): Record<string, unknown> {
    const verified = currentVerifiedPlainData ?? new WeakSet<object>()
    const scope: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(vars)) {
        const converted = toPlainData({ value: vars[key], verified, ancestors: new WeakSet<object>() })
        scope[key] = converted === undefined ? null : converted
    }
    verified.add(scope)
    return scope
}

// One value, with `JSON.parse(JSON.stringify(value))` semantics: `toJSON` is
// honoured first (a `Date` becomes its ISO string, a `Buffer` its
// `{ type, data }` form) and the object it returns is then converted without
// consulting `toJSON` again, exactly as `JSON.stringify` does. Returns
// `undefined` for a value JSON has no representation for; the caller decides
// whether that means "omit the key" (objects) or `null` (arrays, scope root).
// Known deviation from the JSON round trip: a boxed primitive (`new
// Number(1)`) becomes `{}` rather than its primitive; nothing that reaches a
// formula produces one. A cycle is reported as an error rather than relying
// on the recursion overflowing.
function toPlainData({ value, verified, ancestors }: PlainDataConversion): unknown {
    if (isRecord(value) && hasToJson(value)) {
        return toPlainDataNode({ value: value.toJSON(), verified, ancestors })
    }
    return toPlainDataNode({ value, verified, ancestors })
}

function toPlainDataNode({ value, verified, ancestors }: PlainDataConversion): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (!isRecord(value)) return undefined
    if (ancestors.has(value)) {
        throw new Error('Formula input data contains a circular reference')
    }
    ancestors.add(value)
    let converted: Record<string, unknown> | unknown[]
    if (Array.isArray(value)) {
        const items: unknown[] = value
        converted = items.map((item) => toPlainData({ value: item, verified, ancestors }) ?? null)
    }
    else {
        const copy: Record<string, unknown> = {}
        for (const key of Object.keys(value)) {
            const item = toPlainData({ value: value[key], verified, ancestors })
            if (item !== undefined) copy[key] = item
        }
        converted = copy
    }
    ancestors.delete(value)
    verified.add(converted)
    return converted
}

// S2 (see RUNTIME DATA INVARIANTS above). Walks `value` — array elements and
// own enumerable string keys of objects, with an explicit stack — and throws
// if a function sits anywhere in it. Objects already in
// `currentVerifiedPlainData` are skipped and newly walked ones are added, so
// a scope value that is only passed along costs one identity check, and a
// cycle terminates. An object is recorded before its children are walked;
// if a child then turns out to be a function the throw ends the evaluation
// and the per-evaluation set with it, so the early record is never trusted.
// Returns `value` so it can wrap a return expression.
function assertHoldsNoFunction<T>(value: T): T {
    const verified = currentVerifiedPlainData ?? new WeakSet<object>()
    const pending: unknown[] = [value]
    while (pending.length > 0) {
        const current = pending.pop()
        if (typeof current === 'function') {
            throw new FormulaSecurityError(FUNCTION_VALUE_MESSAGE)
        }
        if (!isRecord(current) || verified.has(current)) continue
        verified.add(current)
        if (Array.isArray(current)) {
            const items: unknown[] = current
            for (const item of items) pending.push(item)
        }
        else {
            for (const key of Object.keys(current)) pending.push(current[key])
        }
    }
    return value
}

// S2's wrapper for one `parser.functions` / operator-table entry: every
// argument in, and the value out, must hold no function. Variadic on purpose
// — the library calls entries positionally with differing arities (`=` is
// `setVar(name, value, variables)`, `[` is `arrayIndex(array, index)`), and the
// default-argument padding above reads `args.length`, so nothing may be
// reshaped on the way through. Arguments are checked BEFORE the entry runs,
// so `=` never writes a refused value into the scope.
function guardPlainData(impl: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
        for (const arg of args) assertHoldsNoFunction(arg)
        return assertHoldsNoFunction(impl(...args))
    }
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
    return typeof value === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
    return 'toJSON' in value && typeof value.toJSON === 'function'
}

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value
    if (value == null) return []
    return [value]
}

// Own properties only, like `resolveVariable` in formula-evaluator.ts: a field
// name read off a list item must never surface an inherited built-in.
function readField(item: unknown, field: string): unknown {
    if (item !== null && typeof item === 'object' && Object.hasOwn(item, field)) {
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
    if (item != null && typeof item === 'object' && Object.hasOwn(item, path)) {
        return (item as Record<string, unknown>)[path]
    }
    let value = item
    for (const part of path.split('.')) {
        if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
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

// expr-eval's own internal instruction-type tags — not part of its public
// API, just string literals its source happens to use today. Named here,
// once, and reused by `findSecurityViolation` and the module-load self-check
// further down, so they can't drift apart from each other even if someone
// edits one without the others; they can still drift from expr-eval itself,
// which is exactly what the self-check exists to catch.
const IMEMBER_INSTRUCTION_TYPE = 'IMEMBER'
const IEXPR_INSTRUCTION_TYPE = 'IEXPR'
const IVAR_INSTRUCTION_TYPE = 'IVAR'
const IVARNAME_INSTRUCTION_TYPE = 'IVARNAME'
const INUMBER_INSTRUCTION_TYPE = 'INUMBER'
const IFUNCALL_INSTRUCTION_TYPE = 'IFUNCALL'
const UNKNOWN_CONSTRUCT_MESSAGE = 'Formula contains a construct that is not allowed'
const FUNCTION_VALUE_MESSAGE = 'Formula functions can only be called, not used as values'

// The pre-evaluation pass over a parsed formula, run in `evaluateRaw` before
// evaluation. Walks the PARSED instruction tree (`Expression.tokens`, what
// `.evaluate()` runs) rather than the raw text, because
// `wrapStringArgs`/`normalizeExpression` (formula-evaluator.ts) rewrite the
// string before it is parsed, so a raw-text check would inspect something other
// than what runs. Returns a user-facing message for the first violation, or
// null. It checks NAMES only — it does not model the evaluator's value stack
// and makes no claim about which values are functions at runtime; that is
// S1/S2 in the RUNTIME DATA INVARIANTS comment above. What it refuses:
//
//   D3a — `constructor`/`__proto__`/`prototype` as member access (`IMEMBER`),
//   as a bare identifier (`IVAR`) and as an assignment target (`IVARNAME`).
//
//   D2 (identifier half) — an identifier a resolution table would only find
//   through its prototype. See `isInheritedIdentifier`.
//
//   A unary operator's name written as a value (`(abs)`, `[sqrt]`) rather
//   than applied (`abs -3`). It would resolve to the operator's implementation
//   as a function value; no documented formula does this, so it is refused up
//   front with a message that names the problem rather than left to S2, which
//   refuses it wherever a function or operator would consume it.
//
//   D3b — a unary/binary/ternary operator whose name is only inherited from
//   `Object.prototype` (`toString`, `valueOf`, ...): `isNamedOp` uses `in`, so
//   such a name tokenizes as an operator; requiring own-ness blocks those while
//   leaving every real operator (`+`, `-`, `!`, `sin`, `and`, `||`, `[`, `?`,
//   ...) untouched.
//
//   D4 backstop — `IFUNDEF`, unreachable with `fndef: false`.
//
//   Any instruction type this module has not reviewed. Refused rather than
//   evaluated, so a future library version cannot add a construct silently.
//
// `IEXPR` wraps a nested sub-array (ternary branches, the right-hand side of
// `and`/`or`/assignment) that the library evaluates on its own, so each is
// walked recursively.
function findSecurityViolation(tokens: ExprEvalInstruction[]): string | null {
    for (const instruction of tokens) {
        const value = instruction.value
        switch (instruction.type) {
            case INUMBER_INSTRUCTION_TYPE:
            case IFUNCALL_INSTRUCTION_TYPE:
            case 'IENDSTATEMENT':
            case 'IARRAY':
                break
            case IVAR_INSTRUCTION_TYPE:
            case IVARNAME_INSTRUCTION_TYPE: {
                const violation = identifierViolation(value)
                if (violation !== null) return violation
                break
            }
            case IMEMBER_INSTRUCTION_TYPE:
                if (typeof value !== 'string' || FORBIDDEN_MEMBER_NAMES.has(value)) {
                    return `Formula cannot access ".${String(value)}" — this property name is not allowed`
                }
                break
            case 'IOP1':
                if (!isOwnOperator({ table: parser.unaryOps, name: value })) return operatorViolationMessage(value)
                break
            case 'IOP2':
                if (!isOwnOperator({ table: parser.binaryOps, name: value })) return operatorViolationMessage(value)
                break
            case 'IOP3':
                if (!isOwnOperator({ table: parser.ternaryOps, name: value })) return operatorViolationMessage(value)
                break
            case 'IFUNDEF':
                return 'Defining functions inside a formula is not supported'
            case IEXPR_INSTRUCTION_TYPE: {
                if (!isInstructionArray(value)) return UNKNOWN_CONSTRUCT_MESSAGE
                const nested = findSecurityViolation(value)
                if (nested !== null) return nested
                break
            }
            default:
                return UNKNOWN_CONSTRUCT_MESSAGE
        }
    }
    return null
}

function identifierViolation(name: unknown): string | null {
    if (typeof name !== 'string') return UNKNOWN_CONSTRUCT_MESSAGE
    if (FORBIDDEN_MEMBER_NAMES.has(name) || isInheritedIdentifier(name)) {
        return `Formula cannot use "${name}" — this name is not allowed`
    }
    if (!isOwnFunctionKey(name) && Object.hasOwn(parser.unaryOps, name)) {
        return FUNCTION_VALUE_MESSAGE
    }
    return null
}

// expr-eval resolves a bare identifier with `name in expr.functions`, then
// `name in expr.unaryOps`, then `values[name]` — and `in` walks the prototype
// chain. `parser.functions` is null-prototyped and the scope root built by
// `toPlainDataScope` is too, but `parser.unaryOps` deliberately keeps
// `Object.prototype` (see "Why NOT null the operator tables" above), so a name
// such as `toString` would otherwise resolve to the inherited
// `Object.prototype` method as a value. Refusing every identifier that a
// resolution table would only find through its prototype keeps identifier
// resolution on own properties without touching that table.
function isInheritedIdentifier(name: string): boolean {
    const resolutionTables: object[] = [parser.functions, parser.unaryOps]
    return resolutionTables.some((table) => name in table && !Object.hasOwn(table, name))
}

function isOwnFunctionKey(name: string): boolean {
    return Object.hasOwn(parser.functions, name)
}

function isOwnOperator({ table, name }: { table: Record<string, unknown>, name: unknown }): boolean {
    return typeof name === 'string' && Object.hasOwn(table, name)
}

function operatorViolationMessage(name: unknown): string {
    return typeof name === 'string'
        ? `Formula cannot use "${name}" — this name is not allowed`
        : 'Formula contains an operator that is not allowed'
}

// Self-check, run once at module load: parses tiny known expressions with THIS
// parser instance and asserts the instruction tree carries the tags
// `findSecurityViolation` assumes, and that the library still refuses a callee
// that is not an entry of `parser.functions`. These instruction-type strings
// and that callee check are library internals, not published API — if a future
// version renames a tag or drops the check, the corresponding barrier would
// silently stop applying with zero signal, the same failure shape as the
// `builtInConcat`/`Reflect.deleteProperty` checks. Throwing here turns that
// into a loud failure at startup.
{
    const memberAccessProbe = parser.parse('a.b')
    if (!memberAccessProbe.tokens.some((token) => token.type === IMEMBER_INSTRUCTION_TYPE)) {
        throw new Error(
            `expr-eval no longer tags member access ("a.b") as "${IMEMBER_INSTRUCTION_TYPE}" — the constructor/__proto__/prototype member-access filter is no longer effective`,
        )
    }
    const nestedExprProbe = parser.parse('a ? b.c : d')
    if (!nestedExprProbe.tokens.some((token) => token.type === IEXPR_INSTRUCTION_TYPE)) {
        throw new Error(
            `expr-eval no longer tags ternary/assignment branches ("a ? b.c : d") as "${IEXPR_INSTRUCTION_TYPE}" — the member-access filter's recursion into nested branches is no longer effective`,
        )
    }
    const identifierProbe = parser.parse('abc')
    if (!identifierProbe.tokens.some((token) => token.type === IVAR_INSTRUCTION_TYPE)) {
        throw new Error(
            `expr-eval no longer tags a bare identifier ("abc") as "${IVAR_INSTRUCTION_TYPE}" — the identifier-name filter is no longer effective`,
        )
    }
    const callProbe = parser.parse('uppercase("x")')
    if (!callProbe.tokens.some((token) => token.type === IFUNCALL_INSTRUCTION_TYPE)) {
        throw new Error(
            `expr-eval no longer tags a function call ("uppercase(...)") as "${IFUNCALL_INSTRUCTION_TYPE}" — the parsed tree no longer has the shape this module was checked against`,
        )
    }
    if (findSecurityViolation(callProbe.tokens) !== null) {
        throw new Error('the formula pre-evaluation pass rejects a legitimate call to a registered function')
    }
    // A method read off a string literal is a function the library itself
    // puts on its stack; calling it must be refused by the library's callee
    // allowlist (S1 relies on that check being in place). Evaluated directly,
    // not through `evaluateRaw`, so this probes the library and nothing else.
    let unregisteredCalleeRefused = false
    try {
        parser.parse('"a".at(0)').evaluate({})
    }
    catch {
        unregisteredCalleeRefused = true
    }
    if (!unregisteredCalleeRefused) {
        throw new Error('expr-eval-fork no longer refuses to call a function that is not an entry of parser.functions — only registered formula functions may be callable')
    }
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

// One step of the S1 scope conversion. `verified` is the per-evaluation set
// every produced object is recorded in; `ancestors` holds the input objects
// currently being converted, for cycle detection.
type PlainDataConversion = {
    value: unknown
    verified: WeakSet<object>
    ancestors: WeakSet<object>
}

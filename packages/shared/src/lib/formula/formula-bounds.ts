// Thrown by the size guards in function-implementations.ts. A dedicated type
// (matched with `instanceof` in formula-evaluator.ts) instead of a message
// regex, so the thrower and the catcher are coupled by identity rather than
// by both agreeing to keep saying "too large" in the message text.
export class FormulaSizeLimitError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FormulaSizeLimitError'
    }
}

// expr-eval has no loops or recursion driven by data (verified against the
// `expr-eval` bundle: `evaluate()` is a single linear pass over a fixed,
// already-parsed instruction list), so a formula cannot blow up purely from
// its own expression text. The risk is large-DATA allocation: a resolved
// `{{var}}` payload, or a `from_json`/`to_json` call, that copies or
// re-serializes an already-huge value. `measureSize` walks a value with an
// explicit stack, stopping as soon as the running total exceeds `cap` (the
// exact number returned past that point doesn't matter — callers only need
// "did it exceed", or "how much to charge a shared budget", neither of which
// requires the precise total for a value that's already over).
//
// Arrays get a real O(cap) abort: `.length` is O(1), so an oversized array's
// children are never pushed onto the stack — the cost of rejecting it is
// independent of how many elements it actually has.
//
// Objects do NOT get the same guarantee, and this is a hard V8/ECMAScript
// constraint, not a loop-construct choice: `for...in` must compute the full
// enumerable-key *order* (integer-like keys ascending, then insertion order)
// before it can yield the first key, so on a large dictionary-mode object
// breaking after the first key costs the same as a full pass — measured at
// ~700ms either way for a 3,000,000-key object, whether via `Object.keys()`
// or `for...in` with an early `break`. What `for...in` still buys over
// `Object.keys()` is not visiting fewer keys — it's not allocating a second
// 3,000,000-entry array to hold them, so the object branch is at least O(1)
// extra memory instead of O(n) extra memory. The walk still aborts
// immediately after the first object node that tips the budget rather than
// descending into siblings or children, so the *total* work stays bounded by
// the size of the single largest node encountered, not the whole structure —
// but that one node's own enumeration cost is proportional to its actual key
// count, not to `cap`. A cyclic value still terminates: every revisit of the
// same node adds to `total` again (by that node's own key/element count), so
// a finite `cap` is exceeded after at most `cap` visits even if the
// structure loops forever.
//
// Only own enumerable string keys are counted (`for...in` plus an
// `hasOwnProperty` filter) — this function is written for JSON-shaped data
// (the output of `JSON.parse`, or plain objects/arrays built by the formula
// functions), not arbitrary JS values. `Map`/`Set`/typed arrays/class
// instances with private fields are NOT walked: `for...in` yields no own
// enumerable keys for a `Map` or `Set` (their entries live behind methods,
// not properties), so one is charged only the flat 8-unit "object" cost no
// matter how many entries it holds. That gap is not reachable today — this
// module never produces or consumes `Map`/`Set` values, and `sampleData`
// comes from JSON — but `exceedsSizeBudget`/`measureSize` are exported public
// API, so a future caller passing one of those types would get an
// under-count rather than an error. Documented here rather than guarded
// against, since guarding it means either rejecting types we don't use today
// or reintroducing the enumeration-order cost this function exists to avoid,
// for a type this module has no path to receiving.
export function measureSize({ value, cap }: { value: unknown, cap: number }): number {
    let total = 0
    const stack: unknown[] = [value]

    while (stack.length > 0) {
        const current = stack.pop()

        if (typeof current === 'string') {
            total += current.length
        }
        else if (Array.isArray(current)) {
            total += current.length
            if (total <= cap) {
                for (const item of current) stack.push(item)
            }
        }
        else if (isPlainObject(current)) {
            for (const key in current) {
                if (!Object.prototype.hasOwnProperty.call(current, key)) continue
                total += 1
                if (total > cap) break
                stack.push(current[key])
            }
        }
        else if (typeof current === 'number' || typeof current === 'boolean') {
            total += 8
        }

        if (total > cap) return total
    }

    return total
}

export function exceedsSizeBudget({ value, maxSize }: { value: unknown, maxSize: number }): boolean {
    return measureSize({ value, cap: maxSize }) > maxSize
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A hand-authored formula is at most a few hundred characters in practice;
// 200_000 leaves generous headroom for pasted inline JSON literals while
// still rejecting the multi-megabyte pastes a size-DoS attempt would need.
export const FORMULA_MAX_EXPRESSION_LENGTH = 200_000

// Bounds the total size of the `{{var}}` values resolved into a whole
// template — every occurrence, not deduplicated by variable identity, since
// each repetition of `{{x}}` contributes its own copy of `x` to whatever the
// caller concatenates the segments into. Landing in the "few hundred KB-1 MB"
// range the hardening proposal asked for.
export const FORMULA_MAX_INPUT_SIZE = 1_000_000

// The STARTING size of a shared per-evaluation budget (see
// `currentJsonValueBudget` in function-implementations.ts) that from_json's
// input and to_json's input draw down from — not a fresh per-call ceiling.
// Chaining many from_json()/to_json() calls within one evaluation shares this
// one allowance, so N calls can't each get their own budget. NOT the same
// unit in both places: from_json charges it a plain character count against
// the input string's `.length` (its cost is exactly `JSON.parse`'s input
// size). to_json charges it `measureSize`'s synthetic units (string chars, 8
// per number/boolean, 1 per array element or object key) against the value
// being serialized. The two units coincide closely enough for
// string-dominated JSON payloads (the common case) that one ceiling for both
// is reasonable; if object/array-heavy JSON payloads become common this
// should split into two constants with a documented conversion between them.
// Deliberately tighter than FORMULA_MAX_INPUT_SIZE: JSON.parse / JSON.stringify
// build a whole extra copy of the value in one call, which is costlier per
// unit than the plain walk the engine-wide guard does, and the gap is also
// what keeps the two guards independently testable rather than the outer one
// always masking the inner one.
export const FORMULA_MAX_JSON_VALUE_BUDGET = 300_000

// The STARTING size of a shared per-evaluation budget that replace() and
// join_list() draw down from — not a fresh per-call ceiling. Both can produce
// a result whose length is multiplicative in their inputs (roughly
// `|s| / |from| * |to|` for replace()), not additive, so a modest-sized `s`
// and `to` can still build a gigabytes-large result that the whole-template
// resolved-var budget above never sees (it only charges the additive
// `|s| + |to|`, not the multiplied-out result). A fresh allowance per call
// isn't enough either: chaining N such calls together (e.g. via suffix()/
// combine(), which just concatenate without any check of their own) lets each
// call build up to the full ceiling, producing up to N times the intended
// limit — this is why replace()/join_list() debit ONE shared counter for the
// whole evaluation instead of comparing their own output against this
// constant directly. remove() is NOT guarded: it joins with '', so it can
// only shrink or preserve its input's length, never amplify — a size guard
// on it can only ever produce a false rejection, never prevent a real one.
export const FORMULA_MAX_BUILT_STRING_LENGTH = 1_000_000

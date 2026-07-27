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
// re-serializes an already-huge value. `exceedsSizeBudget` walks a value with
// an explicit stack and aborts the moment the running budget goes negative.
//
// Arrays get a real O(maxSize) abort: `.length` is O(1), so an oversized
// array is rejected before a single element is pushed onto the stack.
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
// count, not to maxSize. A cyclic value still terminates: every revisit of
// the same node decrements `remaining` again (by that node's own key/element
// count), so a finite `maxSize` is exhausted after at most `maxSize` visits
// even if the structure loops forever.
export function exceedsSizeBudget({ value, maxSize }: { value: unknown, maxSize: number }): boolean {
    let remaining = maxSize
    const stack: unknown[] = [value]

    while (stack.length > 0) {
        const current = stack.pop()

        if (typeof current === 'string') {
            remaining -= current.length
            if (remaining < 0) return true
            continue
        }

        if (Array.isArray(current)) {
            remaining -= current.length
            if (remaining < 0) return true
            for (const item of current) stack.push(item)
            continue
        }

        if (isPlainObject(current)) {
            for (const key in current) {
                if (!Object.prototype.hasOwnProperty.call(current, key)) continue
                remaining -= 1
                if (remaining < 0) return true
                stack.push(current[key])
            }
            continue
        }

        if (typeof current === 'number' || typeof current === 'boolean') {
            remaining -= 8
            if (remaining < 0) return true
        }
    }

    return false
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

// Applied to from_json's input and to_json's input specifically. NOT the same
// unit in both places: from_json checks it as a plain character count against
// the input string's `.length` (its cost is exactly `JSON.parse`'s input
// size). to_json checks it via `exceedsSizeBudget`'s synthetic units (string
// chars, 8 per number/boolean, 1 per array element or object key) against the
// value being serialized. The two units coincide closely enough for
// string-dominated JSON payloads (the common case) that one ceiling for both
// is reasonable; if object/array-heavy JSON payloads become common this
// should split into two constants with a documented conversion between them.
// Deliberately tighter than FORMULA_MAX_INPUT_SIZE: JSON.parse / JSON.stringify
// build a whole extra copy of the value in one call, which is costlier per
// unit than the plain walk the engine-wide guard does, and the gap is also
// what keeps the two guards independently testable rather than the outer one
// always masking the inner one.
export const FORMULA_MAX_JSON_VALUE_BUDGET = 300_000

// Caps the PROJECTED character length of a computed string — used by
// replace/remove/join_list, whose output size is multiplicative in their
// inputs (roughly `|s| / |from| * |to|`), not additive, so a modest-sized `s`
// and `to` can still build a gigabytes-large result that the whole-template
// resolved-var budget above never sees (it only charges the additive
// `|s| + |to|`, not the multiplied-out result). Checked BEFORE the actual
// split/join, so the guard's own cost is proportional to counting
// occurrences — O(|s|) — rather than to building the oversized result.
export const FORMULA_MAX_BUILT_STRING_LENGTH = 1_000_000

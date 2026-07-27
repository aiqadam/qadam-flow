// expr-eval has no loops or recursion driven by data (verified against the
// `expr-eval` bundle: `evaluate()` is a single linear pass over a fixed,
// already-parsed instruction list), so a formula cannot blow up purely from
// its own expression text. The risk is large-DATA allocation: a resolved
// `{{var}}` payload, or a `from_json`/`to_json` call, that copies or
// re-serializes an already-huge value. `exceedsSizeBudget` walks a value and
// bails out the moment the remaining budget goes negative — including before
// pushing an oversized array/object's children onto the stack — so a
// pathological input fails fast in O(maxSize) work, not O(actual size).
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

        if (current !== null && typeof current === 'object') {
            const keys = Object.keys(current as Record<string, unknown>)
            remaining -= keys.length
            if (remaining < 0) return true
            for (const key of keys) stack.push((current as Record<string, unknown>)[key])
            continue
        }

        if (typeof current === 'number' || typeof current === 'boolean') {
            remaining -= 8
            if (remaining < 0) return true
        }
    }

    return false
}

// A hand-authored formula is at most a few hundred characters in practice;
// 200_000 leaves generous headroom for pasted inline JSON literals while
// still rejecting the multi-megabyte pastes a size-DoS attempt would need.
export const FORMULA_MAX_EXPRESSION_LENGTH = 200_000

// Bounds the total size of the `{{var}}` values resolved into a formula's
// scope — the issue's "resolved-var payload" — landing in the "few hundred
// KB-1 MB" range the hardening proposal asked for.
export const FORMULA_MAX_INPUT_SIZE = 1_000_000

// Applied to from_json's input string and to_json's input value specifically,
// per the issue's "optionally cap from_json input and to_json output length"
// suggestion. Deliberately tighter than FORMULA_MAX_INPUT_SIZE: JSON.parse /
// JSON.stringify build a whole extra copy of the value in one call, which is
// costlier per byte than the plain walk the engine-wide guard does, and this
// gap is also what keeps the two guards independently testable rather than
// the outer one always masking the inner one.
export const FORMULA_MAX_JSON_TEXT_LENGTH = 300_000

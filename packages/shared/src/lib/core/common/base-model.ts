import { z } from 'zod'
import { formErrors } from '../../form-errors'

export type BaseModel<T> = {
    id: T
    created: string
    updated: string
}

export const DateOrString = z.preprocess(
    (val) => (val instanceof Date ? val.toISOString() : val),
    z.string(),
)

export const BaseModelSchema = {
    id: z.string(),
    created: DateOrString,
    updated: DateOrString,
}

// Used to generate valid nullable in OpenAPI Schema
export const Nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

export function NullableEnum<T extends Record<string, string | number>>(enumObj: T) {
    return z.nativeEnum(enumObj).nullable().optional()
}

export const OptionalBooleanFromQuery = z.preprocess(
    (val) => val === 'true' || val === true ? true : val === 'false' || val === false ? false : undefined,
    z.boolean().optional(),
)

export const OptionalArrayFromQuery = <T extends z.ZodType>(schema: T) =>
    z.preprocess(
        (val) => (Array.isArray(val) ? val : val !== undefined ? [val] : undefined),
        z.array(schema).optional(),
    )

// A length cap that holds before any element is parsed, and a parse that stops at the first
// invalid element. Plain `z.array(el).max(n)` offers neither: zod parses every element before
// it checks the length, and reports one issue per invalid element, so a body of N bad
// elements costs N element parses and an N-entry error however low `n` is — and a nested
// array of them multiplies. The element schema still documents the array in OpenAPI
// (`preprocess` keeps the inner schema on the input side; `transform`/`pipe` would not).
//
// The cost is that a valid array is parsed twice: once here to find the first bad element,
// once by the inner schema that produces the output. `scanned` keeps that from compounding:
// when an enclosing BoundedArray re-parses an element, this array is not scanned again, so
// nested (and recursive, e.g. a flow graph) BoundedArrays cost a scan per array instead of
// doubling per level. Skipping the scan never skips validation — the inner schema always
// runs — it only gives up the early stop for an array this schema already found valid.
export const BoundedArray = <T extends z.ZodType>({ element, max, nonEmpty = false }: BoundedArrayParams<T>) => {
    const scanned = new WeakSet<unknown[]>()
    return z.preprocess(
        (value, ctx) => rejectOversizedOrFirstInvalid({ value, ctx, element, max, scanned }),
        nonEmpty ? z.array(element).min(1, formErrors.required).max(max) : z.array(element).max(max),
    )
}

function rejectOversizedOrFirstInvalid({ value, ctx, element, max, scanned }: RejectParams): unknown {
    if (!Array.isArray(value)) {
        return value
    }
    if (value.length > max) {
        ctx.addIssue({ code: 'too_big', origin: 'array', maximum: max, inclusive: true, input: value })
        return z.NEVER
    }
    if (scanned.has(value)) {
        return value
    }
    for (const [index, item] of value.entries()) {
        const result = element.safeParse(item)
        if (!result.success) {
            for (const issue of result.error.issues) {
                ctx.addIssue({ ...issue, path: [index, ...issue.path] })
            }
            return z.NEVER
        }
    }
    scanned.add(value)
    return value
}

type BoundedArrayParams<T extends z.ZodType> = {
    element: T
    max: number
    nonEmpty?: boolean
}

type RejectParams = {
    value: unknown
    ctx: z.RefinementCtx
    element: z.ZodType
    max: number
    scanned: WeakSet<unknown[]>
}

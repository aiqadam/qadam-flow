import { isNil } from '@aiqadam/shared'
import { asSchema, jsonSchema, Schema } from 'ai'
import { z, ZodRawShape } from 'zod'

/**
 * Small local models — `llama3.1:8b` is the reported one (#267) — routinely emit every tool
 * argument as a JSON string, so `{"limit":"1"}` instead of `{"limit":1}`. The MCP shapes are
 * strict `z.number()`/`z.boolean()`, so the call is rejected on a type technicality even though
 * the model picked the right tool with the right intent.
 *
 * The fix has to be one-sided: the model must still be *told* the argument is a number, or the
 * next token it emits is a string on purpose and every model gets worse. So the JSON Schema
 * handed to the provider is the untouched one Zod derives from the MCP shape, and only the
 * validation of what comes back is lenient.
 *
 * `jsonSchema()` from the AI SDK is what makes that split possible: it takes the advertised
 * schema and the validator as two independent arguments. `parseToolCall`
 * (`ai/dist/index.mjs`, `doParseToolCall`) feeds the model's arguments through
 * `schema.validate` and passes `parseResult.value` on as the tool input, so coercing inside
 * `validate` is what the tool actually executes with.
 */
export const chatToolInput = {
    /**
     * Wraps a raw MCP Zod shape as an AI SDK schema that advertises strictly and validates
     * leniently.
     */
    lenient(shape: ZodRawShape): Schema<Record<string, unknown>> {
        const strict = z.object(shape)
        // `asSchema` on a Zod 4 schema is `zodSchema()`, whose `jsonSchema` is a lazy
        // `z.toJSONSchema(..., { io: 'input' })`. Reusing it rather than re-deriving means the
        // advertised schema is byte-for-byte the one this tool published before this change.
        const advertised = asSchema(strict)

        return jsonSchema<Record<string, unknown>>(() => advertised.jsonSchema, {
            validate: async (value) => {
                const target = await advertised.jsonSchema
                const result = await strict.safeParseAsync(coerce({ value, node: target }))
                return result.success
                    ? { success: true, value: result.data }
                    : { success: false, error: result.error }
            },
        })
    },
}

/**
 * Walks the advertised JSON Schema and the model's arguments together, rewriting only string
 * values that sit where the schema declares a `number`, an `integer` or a `boolean`. Anything
 * that is not one of those three, and any string that does not convert cleanly, is left exactly
 * as it arrived so Zod still rejects it.
 *
 * `anyOf`/`oneOf`/`allOf` branches are deliberately not followed: with more than one candidate
 * type there is no single answer, and guessing one would be the widening this whole module
 * exists to avoid.
 */
function coerce({ value, node }: { value: unknown, node: unknown }): unknown {
    const schema = asObject(node)
    if (isNil(schema)) {
        return value
    }

    const type = schema['type']
    if (typeof value === 'string') {
        if (type === 'number' || type === 'integer') {
            return coerceNumber(value)
        }
        if (type === 'boolean') {
            return coerceBoolean(value)
        }
        return value
    }

    if (Array.isArray(value)) {
        // Tuple forms (`items` as an array) are not produced by any of the MCP shapes, so only
        // the single-schema form is followed.
        const items = asObject(schema['items'])
        return isNil(items) ? value : value.map((entry) => coerce({ value: entry, node: items }))
    }

    const record = asObject(value)
    const properties = asObject(schema['properties'])
    if (isNil(record) || isNil(properties)) {
        return value
    }
    // A key the schema says nothing about has no declared type to coerce toward, so its value is
    // passed through as it arrived. Zod then *strips* it — `z.object` drops unknown keys silently
    // rather than complaining — so it never reaches the tool either way.
    //
    // `Object.hasOwn` changes no behaviour today and no test pins it — measured, not assumed:
    // removing it leaves all 13 unit tests green. It is here because without it
    // `properties['__proto__']` resolves to `Object.prototype`, i.e. the walk would consult a
    // schema node the schema never declared. That is harmless only because `Object.prototype`
    // happens to carry no `type`/`properties`/`items`; the guard is what keeps it harmless if a
    // future branch starts reading other keys off the node.
    return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
            key,
            coerce({ value: entry, node: Object.hasOwn(properties, key) ? properties[key] : undefined }),
        ]),
    )
}

function coerceNumber(value: string): string | number {
    const trimmed = value.trim()
    // `Number('')` is 0 and `Number('abc')` is NaN — neither is a number the model meant to send.
    if (trimmed.length === 0) {
        return value
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : value
}

/**
 * Exactly `"true"` and `"false"`, in any letter case, with surrounding whitespace ignored.
 * Nothing else: not `"1"`, not `"yes"`, not `"on"`. `z.coerce.boolean()` cannot be used here
 * because it is `Boolean(value)`, and `Boolean('false')` is `true` — it would turn every model
 * that says "false" into one that means "true", which is worse than the bug.
 */
function coerceBoolean(value: string): string | boolean {
    switch (value.trim().toLowerCase()) {
        case 'true':
            return true
        case 'false':
            return false
        default:
            return value
    }
}

/**
 * A type guard rather than a cast (CLAUDE.md prescribes `unknown` plus type guards), so the one
 * unavoidable assertion lives in a single one-line body instead of at four call sites. TypeScript
 * does not verify a predicate's body against the asserted type, so this is a relocated assertion,
 * not a checked one — `{ ...value }` would be genuinely checked but copies every schema node at
 * every step of the walk.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && !isNil(value) && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined
}

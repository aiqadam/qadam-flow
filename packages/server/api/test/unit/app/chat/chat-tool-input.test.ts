import { isNil } from '@aiqadam/shared'
import { asSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatToolInput } from '../../../../src/app/chat/chat-tool-input'

const shape = {
    limit: z.number().int().min(1).max(500).optional().describe('Max flows to return (default 100, max 500).'),
    status: z.enum(['ENABLED', 'DISABLED']).optional().describe('Filter by status: ENABLED or DISABLED.'),
    name: z.string().optional(),
    // Deliberately unconstrained: `limit` has `.min(1)`, so a coercer that silently turned
    // nonsense into `0` would still be rejected by the range and every assertion about
    // `limit` would pass anyway. `offset` accepts `0`, so it is the only field on which
    // "nonsense was swallowed" and "nonsense was refused" give different answers.
    offset: z.number().optional(),
    skip: z.boolean().optional(),
    steps: z.array(z.object({ continueOnFailure: z.boolean().optional(), x: z.number() })).optional(),
    // The shape 12 of the MCP tools use for piece/step config. It emits no `type`, so nothing
    // inside it is coerced — the passthrough this module must not touch.
    config: z.record(z.string(), z.unknown()).optional(),
}

async function validate(value: unknown): Promise<{ success: boolean, value?: unknown, message?: string }> {
    const { validate: run } = chatToolInput.lenient(shape)
    if (isNil(run)) {
        throw new Error('chatToolInput.lenient must expose a validate function')
    }
    const result = await run(value)
    return result.success ? { success: true, value: result.value } : { success: false, message: result.error.message }
}

// Indexed through a type guard rather than `Reflect.get`, which is typed `any` for a key that is
// not `keyof object` and would quietly hand back an unchecked value. `typeof` has to run before
// `isNil` here: `isNil` is generic over `T | null | undefined`, so on an `unknown` it cannot
// subtract `null`, and the narrowing only lands once `typeof === 'object'` has been established.
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && !isNil(value) && !Array.isArray(value)
}

function advertisedProperties(schema: unknown): Record<string, unknown> {
    if (!isRecord(schema)) {
        throw new Error('advertised JSON Schema is not an object')
    }
    const properties = schema['properties']
    if (!isRecord(properties)) {
        throw new Error('advertised JSON Schema has no properties')
    }
    return properties
}

describe('chatToolInput.lenient', () => {
    // The whole point of the split: the model is still told `limit` is an integer. Widening the
    // advertised schema to `number | string` would teach every model to send strings, so this
    // asserts the published JSON Schema is character-for-character the strict one.
    it('advertises exactly the JSON Schema the strict Zod object would', async () => {
        const strict = await asSchema(z.object(shape)).jsonSchema
        const lenient = await asSchema(chatToolInput.lenient(shape)).jsonSchema

        expect(JSON.stringify(lenient)).toEqual(JSON.stringify(strict))
        expect(advertisedProperties(lenient).limit).toMatchObject({ type: 'integer' })
        expect(advertisedProperties(lenient).skip).toMatchObject({ type: 'boolean' })
    })

    it('reads a stringified number as the number the model meant', async () => {
        await expect(validate({ limit: '1' })).resolves.toEqual({ success: true, value: { limit: 1 } })
    })

    it('reads only the exact strings "true" and "false" as booleans, in any letter case', async () => {
        await expect(validate({ skip: 'true' })).resolves.toEqual({ success: true, value: { skip: true } })
        // `z.coerce.boolean()` is `Boolean(value)`, and `Boolean('false')` is `true` — the one
        // wrong answer this whole helper exists to avoid.
        await expect(validate({ skip: 'false' })).resolves.toEqual({ success: true, value: { skip: false } })
        await expect(validate({ skip: 'FALSE' })).resolves.toEqual({ success: true, value: { skip: false } })
    })

    it('refuses every other truthy-looking string for a boolean rather than guessing', async () => {
        for (const value of ['1', '0', 'yes', 'no', 'on', '']) {
            const result = await validate({ skip: value })
            expect(result.success, `"${value}" must not be read as a boolean`).toBe(false)
        }
    })

    it('leaves genuine nonsense alone so Zod still rejects it', async () => {
        const result = await validate({ limit: 'abc' })

        expect(result.success).toBe(false)
        expect(result.message).toContain('limit')
    })

    // The control for the test above. Asserted on `offset` (no `.min()`) because on `limit` a
    // coercer that returned `0` for unparseable input would still be caught by the range — so
    // that assertion holds whether or not the nonsense was actually left alone. Here it does not:
    // swallowing `"abc"` as `0` makes this input valid, and this test is the thing that fails.
    it('does not invent a number for nonsense on a field where zero would be valid', async () => {
        await expect(validate({ offset: 'abc' })).resolves.toMatchObject({ success: false })
        await expect(validate({ offset: 'Infinity' })).resolves.toMatchObject({ success: false })
        await expect(validate({ offset: '' })).resolves.toMatchObject({ success: false })
        await expect(validate({ offset: '  ' })).resolves.toMatchObject({ success: false })
        // And the field itself does accept a real zero, so the rejections above are about the
        // nonsense, not about `offset` refusing `0` for some unrelated reason.
        await expect(validate({ offset: '0' })).resolves.toEqual({ success: true, value: { offset: 0 } })
    })

    // Named for what it can actually observe. Every input here is on `limit`, whose `.min(1)`
    // rejects a swallowed `0` on its own, so this cannot demonstrate that the value was left
    // uncoerced — only that it was refused. It still earns its place: it catches a coercer that
    // invented a *nonzero* wrong number. The non-coercion property is owned by the `offset` test.
    it('rejects an empty or non-finite limit instead of accepting it', async () => {
        // `Number('')` is 0 — a silent, plausible-looking wrong answer if left to `z.coerce`.
        await expect(validate({ limit: '' })).resolves.toMatchObject({ success: false })
        await expect(validate({ limit: '  ' })).resolves.toMatchObject({ success: false })
        await expect(validate({ limit: 'Infinity' })).resolves.toMatchObject({ success: false })
    })

    it('still enforces the constraints around the type, not just the type', async () => {
        // Coerced to 1.5, then rejected by `.int()`; and coerced to 900, then rejected by `.max()`.
        await expect(validate({ limit: '1.5' })).resolves.toMatchObject({ success: false })
        await expect(validate({ limit: '900' })).resolves.toMatchObject({ success: false })
    })

    it('coerces inside arrays and nested objects, where half the numeric fields actually live', async () => {
        await expect(validate({ steps: [{ continueOnFailure: 'true', x: '3' }] })).resolves.toEqual({
            success: true,
            value: { steps: [{ continueOnFailure: true, x: 3 }] },
        })
    })

    it('never touches a value the schema declares as a string', async () => {
        await expect(validate({ name: '5', status: 'ENABLED' })).resolves.toEqual({
            success: true,
            value: { name: '5', status: 'ENABLED' },
        })
    })

    // The 12 tools that take piece/step config declare it as `z.record(z.string(), z.unknown())`,
    // whose JSON Schema has no `properties` and no `type` for its members. Coercing in there would
    // be guessing at a piece's own prop types, so the walk must stop at the boundary.
    it('does not reach inside a freeform record, where it has no schema to coerce against', async () => {
        await expect(validate({ config: { retries: '3', enabled: 'true' } })).resolves.toEqual({
            success: true,
            value: { config: { retries: '3', enabled: 'true' } },
        })
    })

    // A model-supplied `__proto__` key must neither pollute the result's prototype nor survive
    // into the validated value. This pins the outcome, not the `Object.hasOwn` guard in `coerce`:
    // removing that guard keeps this test green, because `Object.prototype` carries no `type` for
    // the walk to act on. Kept as a regression guard on the behaviour models can actually reach.
    it('does not let a __proto__ or constructor key borrow a schema node', async () => {
        const result = await validate(JSON.parse('{"limit":"1","__proto__":{"polluted":true},"constructor":"x"}'))

        expect(result).toEqual({ success: true, value: { limit: 1 } })
        expect(Object.keys({}).length).toBe(0)
        expect(Reflect.get({}, 'polluted')).toBeUndefined()
    })

    it('passes correctly typed input through untouched', async () => {
        await expect(validate({ limit: 2, skip: false })).resolves.toEqual({ success: true, value: { limit: 2, skip: false } })
        await expect(validate({})).resolves.toEqual({ success: true, value: {} })
    })
})

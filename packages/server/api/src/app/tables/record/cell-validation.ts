import { ErrorCode, Field, FieldType, formErrors, isNil, QadamFlowError, tryCatchSync } from '@aiqadam/shared'

// Deep enough that no schema a human writes reaches it, shallow enough that the recursion
// cannot exhaust the call stack. See firstSchemaViolation.
const MAX_JSON_SCHEMA_DEPTH = 64

// The one place every cell write funnels through — create(), update(), updateMany() and
// upsert() in record.service.ts all call this before a cell reaches the database. Before
// #390 there was no write-time validation for any field type; STATIC_DROPDOWN is added
// here alongside BOOLEAN/JSON because it is the same mechanism and was explicitly called
// out as in-scope.
//
// An absent or empty cell is always valid regardless of type — empty means "unset", not a
// forced default, matching buildKeyReader's existing treatment of "no cell" and "empty
// cell" as the same thing.
export function assertValidCellValues({ cells, fieldsById }: { cells: { fieldId: string, value: string | null }[], fieldsById: Map<string, Field> }): void {
    for (const cell of cells) {
        const field = fieldsById.get(cell.fieldId)
        if (isNil(field)) {
            continue
        }
        assertValidCellValue({ field, value: cell.value })
    }
}

function assertValidCellValue({ field, value }: { field: Field, value: string | null }): void {
    if (isNil(value) || value === '') {
        return
    }
    switch (field.type) {
        case FieldType.BOOLEAN:
            if (value !== 'true' && value !== 'false') {
                const message = formErrors.invalidBooleanValue
                throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Column "${field.name}" is BOOLEAN — value must be "true", "false", or empty, but got "${truncate(value)}".`)
            }
            return
        case FieldType.JSON: {
            const { data, error } = tryCatchSync<unknown>(() => JSON.parse(value))
            if (error !== null) {
                const message = formErrors.invalidJsonValue
                throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Column "${field.name}" is JSON — value must be valid JSON, or empty, but got "${truncate(value)}".`)
            }
            const schema = field.data?.schema
            if (!isNil(schema)) {
                assertMatchesJsonSchema({ field, value: data, schema })
            }
            return
        }
        case FieldType.STATIC_DROPDOWN:
            // `field.data` is typed as required for this variant but the COLUMN is
            // nullable (field.entity.ts), so a row written before that invariant existed
            // would turn every write to its table into a TypeError → 500. An options list
            // nobody declared constrains nothing, so a missing one validates as before.
            if (isNil(field.data) || field.data.options.length === 0) {
                return
            }
            if (!field.data.options.some((option) => option.value === value)) {
                const message = formErrors.valueNotInOptions
                throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Column "${field.name}" is STATIC_DROPDOWN — "${truncate(value)}" is not one of its declared options.`)
            }
            return
        case FieldType.TEXT:
        case FieldType.NUMBER:
        case FieldType.DATE:
            return
    }
}

// Deliberately minimal — the field-creation-time `data.schema` is an optional JSON-Schema-
// shaped string, and this checks the subset that catches real mistakes (wrong shape,
// missing required property, wrong leaf type) without reimplementing a JSON Schema
// validation engine. `schema` was already validated to be well-formed JSON representing an
// object at field-creation time (field.service.ts); anything that slipped past that simply
// constrains nothing here rather than failing the write.
function assertMatchesJsonSchema({ field, value, schema }: { field: Field, value: unknown, schema: string }): void {
    const { data: parsedSchema } = tryCatchSync<unknown>(() => JSON.parse(schema))
    const violation = firstSchemaViolation({ value, schema: parsedSchema, path: '$', depth: 0 })
    if (isNil(violation)) {
        return
    }
    const message = formErrors.jsonSchemaMismatch
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Column "${field.name}" is JSON with a declared schema — ${violation}`)
}

// Depth-capped. Both sides of this walk are attacker-shaped: `schema` is an unbounded
// string a field creator supplies, and `value` is an unbounded document any writer
// supplies, so an unguarded recursion is a RangeError — a 500 — on a ~5000-deep nesting
// that JSON.parse itself survives. Past the cap the value is accepted rather than
// rejected: the cap is a resource guard, not a rule about the data, and a document nobody
// can describe a schema for should not become unwritable.
// The schema stays `unknown` all the way down and is narrowed by guards at each step,
// rather than asserted into a shape with `as`. That is not only the AGENTS.md rule: a
// keyword this subset does not implement, or a malformed nested schema, now constrains
// nothing instead of being read as a constraint the value cannot satisfy — an unknown
// `type` must not reject data that is perfectly fine.
function firstSchemaViolation({ value, schema, path, depth }: FirstSchemaViolationParams): string | null {
    if (depth > MAX_JSON_SCHEMA_DEPTH || !isPlainObject(schema)) {
        return null
    }
    const { type, required, properties, items } = schema
    if (isMinimalJsonSchemaType(type) && !matchesJsonSchemaType(value, type)) {
        return `${path} must be of type ${type}, got ${describeJsonType(value)}.`
    }
    if (Array.isArray(required) && isPlainObject(value)) {
        const missing = required.filter((key): key is string => typeof key === 'string').find((key) => !(key in value))
        if (!isNil(missing)) {
            return `${path} is missing required property "${missing}".`
        }
    }
    if (isPlainObject(properties) && isPlainObject(value)) {
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                const nested = firstSchemaViolation({ value: value[key], schema: propertySchema, path: `${path}.${key}`, depth: depth + 1 })
                if (!isNil(nested)) {
                    return nested
                }
            }
        }
    }
    if (!isNil(items) && Array.isArray(value)) {
        for (const [index, element] of value.entries()) {
            const nested = firstSchemaViolation({ value: element, schema: items, path: `${path}[${index}]`, depth: depth + 1 })
            if (!isNil(nested)) {
                return nested
            }
        }
    }
    return null
}

function isMinimalJsonSchemaType(type: unknown): type is MinimalJsonSchemaType {
    return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null' || type === 'array' || type === 'object'
}

function matchesJsonSchemaType(value: unknown, type: MinimalJsonSchemaType): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string'
        case 'number':
            return typeof value === 'number'
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value)
        case 'boolean':
            return typeof value === 'boolean'
        case 'null':
            return value === null
        case 'array':
            return Array.isArray(value)
        case 'object':
            return isPlainObject(value)
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeJsonType(value: unknown): string {
    if (value === null) {
        return 'null'
    }
    if (Array.isArray(value)) {
        return 'array'
    }
    return typeof value
}

function truncate(value: string): string {
    return value.length <= MAX_REPORTED_VALUE_LENGTH ? value : `${value.slice(0, MAX_REPORTED_VALUE_LENGTH)}…`
}

const MAX_REPORTED_VALUE_LENGTH = 100

type MinimalJsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object'

type FirstSchemaViolationParams = {
    value: unknown
    schema: unknown
    path: string
    depth: number
}

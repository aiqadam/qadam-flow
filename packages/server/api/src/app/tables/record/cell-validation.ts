import { ErrorCode, Field, FieldType, formErrors, isNil, QadamFlowError, tryCatchSync } from '@aiqadam/shared'

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
// object at field-creation time (field.service.ts), so parsing it here is not re-guarded.
function assertMatchesJsonSchema({ field, value, schema }: { field: Field, value: unknown, schema: string }): void {
    const { data: parsedSchema } = tryCatchSync<unknown>(() => JSON.parse(schema))
    if (isNil(parsedSchema) || typeof parsedSchema !== 'object') {
        return
    }
    const violation = firstSchemaViolation({ value, schema: parsedSchema as MinimalJsonSchema, path: '$' })
    if (isNil(violation)) {
        return
    }
    const message = formErrors.jsonSchemaMismatch
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Column "${field.name}" is JSON with a declared schema — ${violation}`)
}

function firstSchemaViolation({ value, schema, path }: { value: unknown, schema: MinimalJsonSchema, path: string }): string | null {
    if (!isNil(schema.type) && !matchesJsonSchemaType(value, schema.type)) {
        return `${path} must be of type ${schema.type}, got ${describeJsonType(value)}.`
    }
    if (!isNil(schema.required) && isPlainObject(value)) {
        const missing = schema.required.find((key) => !(key in value))
        if (!isNil(missing)) {
            return `${path} is missing required property "${missing}".`
        }
    }
    if (!isNil(schema.properties) && isPlainObject(value)) {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
            if (key in value) {
                const nested = firstSchemaViolation({ value: value[key], schema: propertySchema, path: `${path}.${key}` })
                if (!isNil(nested)) {
                    return nested
                }
            }
        }
    }
    if (!isNil(schema.items) && Array.isArray(value)) {
        for (const [index, element] of value.entries()) {
            const nested = firstSchemaViolation({ value: element, schema: schema.items, path: `${path}[${index}]` })
            if (!isNil(nested)) {
                return nested
            }
        }
    }
    return null
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

type MinimalJsonSchema = {
    type?: MinimalJsonSchemaType
    required?: string[]
    properties?: Record<string, MinimalJsonSchema>
    items?: MinimalJsonSchema
}

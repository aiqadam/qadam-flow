import { z } from 'zod'
import { BaseModelSchema } from '../../core/common'

export enum FieldType {
    TEXT = 'TEXT',
    NUMBER = 'NUMBER',
    DATE = 'DATE',
    STATIC_DROPDOWN = 'STATIC_DROPDOWN',
    BOOLEAN = 'BOOLEAN',
    JSON = 'JSON',
}

// Optional structural hint for a JSON field, mirroring STATIC_DROPDOWN's `data.options`
// pattern. Deliberately minimal — a JSON Schema-shaped string rather than a full JSON
// Schema validation engine: `type`/`properties`/`required`/`items` are checked, nothing
// deeper (see cell-validation.ts on the server). Left unset, a JSON field accepts any
// value that JSON.parse succeeds on.
export const JsonFieldData = z.object({
    schema: z.string().optional(),
})

export type JsonFieldData = z.infer<typeof JsonFieldData>

export const Field = z.union([z.object({
    ...BaseModelSchema,
    name: z.string(),
    externalId: z.string(),
    type: z.literal(FieldType.STATIC_DROPDOWN),
    tableId: z.string(),
    projectId: z.string(),
    data: z.object({
        options: z.array(z.object({
            value: z.string(),
        })),
    }),
}), z.object({
    ...BaseModelSchema,
    name: z.string(),
    externalId: z.string(),
    type: z.literal(FieldType.JSON),
    tableId: z.string(),
    projectId: z.string(),
    data: JsonFieldData.optional(),
}), z.object({
    ...BaseModelSchema,
    name: z.string(),
    externalId: z.string(),
    type: z.union([z.literal(FieldType.TEXT), z.literal(FieldType.NUMBER), z.literal(FieldType.DATE), z.literal(FieldType.BOOLEAN)]),
    tableId: z.string(),
    projectId: z.string(),
})])

export type Field = z.infer<typeof Field>

export const StaticDropdownEmptyOption = {
    label: '',
    value: '',
}

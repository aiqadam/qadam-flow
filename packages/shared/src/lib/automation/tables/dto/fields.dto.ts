import { z } from 'zod'
import { formErrors } from '../../../form-errors'
import { DropdownOptionsInput, DropdownOptionsUpdateInput, FieldType, JsonFieldData } from '../field'


const StaticDropdownData = z.object({
    options: DropdownOptionsInput,
})

export const CreateFieldRequest = z.union([z.object({
    name: z.string(),
    type: z.literal(FieldType.STATIC_DROPDOWN),
    tableId: z.string(),
    data: StaticDropdownData,
    externalId: z.string().optional(),
}), z.object({
    name: z.string(),
    type: z.literal(FieldType.JSON),
    tableId: z.string(),
    data: JsonFieldData.optional(),
    externalId: z.string().optional(),
}), z.object({
    name: z.string(),
    type: z.union([z.literal(FieldType.TEXT), z.literal(FieldType.NUMBER), z.literal(FieldType.DATE), z.literal(FieldType.BOOLEAN)]),
    tableId: z.string(),
    externalId: z.string().optional(),
})])

// `data.options` replaces a STATIC_DROPDOWN's whole option list in place: the field id, its
// externalId and every cell survive. Both keys are optional so a caller can rename without
// touching options and the other way round.
export const UpdateFieldRequest = z.object({
    name: z.string().optional(),
    data: z.object({
        options: DropdownOptionsUpdateInput,
    }).optional(),
}).refine((request) => request.name !== undefined || request.data !== undefined, { message: formErrors.required })

export const ListFieldsRequestQuery = z.object({
    tableId: z.string(),
})

export type CreateFieldRequest = z.infer<typeof CreateFieldRequest>
export type UpdateFieldRequest = z.infer<typeof UpdateFieldRequest>
export type ListFieldsRequestQuery = z.infer<typeof ListFieldsRequestQuery>

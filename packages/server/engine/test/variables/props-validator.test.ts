import { QadamAuth, Property } from '@aiqadam/qadams-framework'
import { propsProcessor } from '../../src/lib/variables/props-processor'
describe('Property Validation', () => {
    describe('required properties', () => {
        it('should validate required string property', async () => {
            const props = {
                text: Property.ShortText({
                    displayName: 'Text',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { text: 'valid text' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: nullErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { text: null },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(nullErrors).toEqual({
                text: ['Expected string, received: null'],
            })

            const { errors: undefinedErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { text: undefined },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(undefinedErrors).toEqual({
                text: ['Expected string, received: undefined'],
            })
        })

        it('should validate required number property', async () => {
            const props = {
                number: Property.Number({
                    displayName: 'Number',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { number: 42 },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: nullErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { number: null },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(nullErrors).toEqual({
                number: ['Expected number, received: null'],
            })

            const { errors: typeErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { number: 'not a number' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(typeErrors).toEqual({
                number: ['Expected number, received: not a number'],
            })
        })

        it('should validate required datetime property', async () => {
            const props = {
                date: Property.DateTime({
                    displayName: 'DateTime',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { date: '2024-03-14T12:00:00.000Z' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: invalidErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { date: 'not a date' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(invalidErrors).toEqual({
                date: ['Invalid datetime format. Expected ISO format (e.g. 2024-03-14T12:00:00.000Z), received: not a date'],
            })
        })

        it('should validate required array property', async () => {
            const props = {
                array: Property.Array({
                    displayName: 'Array',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { array: [1, 2, 3] },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: typeErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { array: 'not an array' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(typeErrors).toEqual({
                array: ['Expected array, received: not an array'],
            })
        })

        it('should validate required json property', async () => {
            const props = {
                json: Property.Json({
                    displayName: 'JSON',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: { key: 'value' } },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: validJsonStringErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: '{"key": "value"}' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validJsonStringErrors).toEqual({})

            const { errors: validArrayErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: [1, 2, 3] },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validArrayErrors).toEqual({})

            const { errors: validArrayStringErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: '[1, 2, 3]' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validArrayStringErrors).toEqual({})

            const { errors: invalidJsonErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: 'not a json object' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(invalidJsonErrors).toEqual({
                json: ['Expected JSON, received: not a json object'],
            })

            const { errors: nullErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: null },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(nullErrors).toEqual({
                json: ['Expected JSON, received: null'],
            })

            const { errors: emptyStringErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: '' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(emptyStringErrors).toEqual({
                json: ['Expected JSON, received: '],
            })

            const { errors: invalidTextErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: 'asd' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(invalidTextErrors).toEqual({
                json: ['Expected JSON, received: asd'],
            })
        })

        it('should validate optional json property with invalid value', async () => {
            const props = {
                json: Property.Json({
                    displayName: 'JSON',
                    required: false,
                }),
            }

            const { errors: validNullErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: null },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validNullErrors).toEqual({})

            const { errors: validUndefinedErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: undefined },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validUndefinedErrors).toEqual({})

            const { errors: emptyStringErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: '' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(emptyStringErrors).toEqual({})

            const { errors: invalidJsonErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: 'not a json object' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(invalidJsonErrors).toEqual({
                json: ['Expected JSON, received: not a json object'],
            })

            const { errors: invalidTextErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { json: 'asd' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(invalidTextErrors).toEqual({
                json: ['Expected JSON, received: asd'],
            })
        })
        it('should validate required object property', async () => {
            const props = {
                object: Property.Object({
                    displayName: 'Object',
                    required: true,
                }),
            }

            const { errors: validErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { object: { key: 'value' } },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(validErrors).toEqual({})

            const { errors: nullErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { object: null },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(nullErrors).toEqual({
                object: ['Expected object, received: null'],
            })

            const { errors: typeErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { object: 'not an object' },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(typeErrors).toEqual({
                object: ['Expected object, received: not an object'],
            })

            const { errors: jsonStringErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { object: JSON.stringify({ key: 'value' }) },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(jsonStringErrors).toEqual({})

            const { errors: undefinedErrors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: { object: { key: 'value' } },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(undefinedErrors).toEqual({})
        })
    })

    describe('optional properties', () => {
        it('should validate optional properties', async () => {
            const props = {
                text: Property.ShortText({
                    displayName: 'Text',
                    required: false,
                }),
                number: Property.Number({
                    displayName: 'Number',
                    required: false,
                }),
            }

            const { errors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: {
                        text: null,
                        number: undefined,
                    },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })
            expect(errors).toEqual({})
        })
    })

    describe('type validation', () => {
        it('should validate property types', async () => {
            const props = {
                string: Property.ShortText({
                    displayName: 'Text',
                    required: true,
                }),
                number: Property.Number({
                    displayName: 'Number',
                    required: true,
                }),
                boolean: Property.Checkbox({
                    displayName: 'Checkbox',
                    required: true,
                }),
                array: Property.Array({
                    displayName: 'Array',
                    required: true,
                }),
                object: Property.Object({
                    displayName: 'Object',
                    required: true,
                }),
            }

            const { errors } = await propsProcessor.applyProcessorsAndValidators({
                resolvedInput: {
                        string: 42,
                        number: 'not a number',
                        boolean: 'not a boolean',
                        array: 'not an array',
                        object: 'not an object',
                    },
                props,
                auth: QadamAuth.None(),
                requireAuth: false,
                propertySettings: {},
            })

            expect(errors).toEqual({
                number: ['Expected number, received: not a number'],
                boolean: ['Expected boolean, received: not a boolean'],
                array: ['Expected array, received: not an array'],
                object: ['Expected object, received: not an object'],
            })
        })
    })
})

import { Property, QadamAuth } from '@aiqadam/qadams-framework'
import { describe, expect, it } from 'vitest'
import { propsProcessor } from '../../src/lib/variables/props-processor'

// Input keys are user data. A bare `record[key]` read resolves `constructor` / `toString` off
// Object.prototype: `processingErrors['constructor']` used to be a function, so the step failed with
// the message `{}` (a function does not survive JSON.stringify) on an input nothing was wrong with.
describe('propsProcessor — input keys that name Object.prototype members', () => {
    const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty']

    it('ignores them at the top level', async () => {
        const resolvedInput = {
            ...Object.fromEntries(PROTOTYPE_KEYS.map((key) => [key, 'x'])),
            text: 'hello',
        }

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput,
            props: { text: Property.ShortText({ displayName: 'Text', required: true }) },
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
        })

        expect(errors).toEqual({})
        expect(processedInput).toEqual(resolvedInput)
    })

    it('ignores them inside a DYNAMIC value and inside ARRAY items', async () => {
        const { errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: {
                media: { constructor: 'x', toString: 'y', caption: 'hi' },
                items: [{ constructor: 'x', name: 'a' }],
            },
            props: {
                media: Property.DynamicProperties({
                    auth: undefined,
                    displayName: 'Media',
                    required: false,
                    refreshers: [],
                    props: async () => ({ caption: Property.ShortText({ displayName: 'Caption', required: true }) }),
                }),
                items: Property.Array({
                    displayName: 'Items',
                    required: true,
                    properties: { name: Property.ShortText({ displayName: 'Name', required: true }) },
                }),
            },
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: {
                server: { apiUrl: 'http://127.0.0.1:3000/', publicUrl: 'http://127.0.0.1:4200/api/', token: 'engine-token' },
                project: { id: 'project-1', externalId: async () => undefined },
                flows: { list: async () => ({ data: [], next: null, previous: null }), current: { id: 'flow-1', version: { id: 'flow-version-1' } } },
                connections: { get: async () => null },
            },
        })

        expect(errors).toEqual({})
    })

    // JSON.parse makes `__proto__` an own data key; it must neither be read as a property nor be
    // assigned through, which would swap the prototype of the processed input.
    it('neither reads nor assigns through an own __proto__ key', async () => {
        const resolvedInput = JSON.parse('{"__proto__": {"polluted": true}, "text": "hello"}')

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput,
            props: { text: Property.ShortText({ displayName: 'Text', required: true }) },
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
        })

        expect(errors).toEqual({})
        expect(Object.getPrototypeOf(processedInput)).toBe(Object.prototype)
        expect(Object.hasOwn(processedInput, '__proto__')).toBe(true)
        expect(Reflect.get({}, 'polluted')).toBeUndefined()
    })
})

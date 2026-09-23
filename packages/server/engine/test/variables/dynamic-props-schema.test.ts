import { ApFile, InputPropertyMap, Property, PropertyContext, QadamAuth } from '@aiqadam/qadams-framework'
import { EngineGenericError, PropertyExecutionType, PropertySettings } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { propsProcessor } from '../../src/lib/variables/props-processor'

// #388: a DYNAMIC prop's sub-fields were processed only when the builder had stored their schema
// in `propertySettings`. Flows written by MCP tools, REST or an import store none, so a FILE
// nested in one reached the qadam as its raw URL / data URI string.
describe('propsProcessor — DYNAMIC props without a stored schema', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('computes the schema through props() and turns a nested data URI into an ApFile', async () => {
        const propsFn = vi.fn(async () => ({
            photo: Property.File({ displayName: 'Photo', required: true }),
        }))
        const resolvedInput = {
            media_type: 'photo',
            media: { photo: 'data:image/png;base64,aGVsbG8=' },
        }

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput,
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(errors).toEqual({})
        expect(processedInput.media.photo).toBeInstanceOf(ApFile)
        expect(processedInput.media.photo.filename).toBe('unknown.png')
        expect(processedInput.media.photo.data.toString()).toBe('hello')
        // The same arguments the builder's executeProps hands it: the step's whole resolved input.
        expect(propsFn).toHaveBeenCalledWith(resolvedInput, PROPERTY_CONTEXT)
    })

    it('downloads a nested http(s) URL', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('pdf-bytes', {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
        }))
        const propsFn = vi.fn(async () => ({
            document: Property.File({ displayName: 'Document', required: true }),
        }))

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { document: 'https://files.example.com/v1/files/abc?token=secret' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(errors).toEqual({})
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(processedInput.media.document).toBeInstanceOf(ApFile)
        expect(processedInput.media.document.filename).toBe('unknown.pdf')
        expect(processedInput.media.document.data.toString()).toBe('pdf-bytes')
    })

    it('treats a propertySettings entry with no schema the same as a missing entry', async () => {
        const propsFn = vi.fn(async () => ({
            photo: Property.File({ displayName: 'Photo', required: true }),
        }))
        // The engine's own AI tools write exactly this shape.
        const propertySettings: Record<string, PropertySettings> = {
            media: { type: PropertyExecutionType.MANUAL, schema: undefined },
        }

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { photo: 'data:image/png;base64,aGVsbG8=' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings,
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(errors).toEqual({})
        expect(propsFn).toHaveBeenCalledTimes(1)
        expect(processedInput.media.photo).toBeInstanceOf(ApFile)
    })

    it('keeps using a stored schema and never calls props()', async () => {
        const propsFn = vi.fn(async () => ({
            photo: Property.ShortText({ displayName: 'Not what the builder stored', required: true }),
        }))
        const propertySettings: Record<string, PropertySettings> = {
            media: {
                type: PropertyExecutionType.MANUAL,
                schema: { photo: Property.File({ displayName: 'Photo', required: true }) },
            },
        }

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { photo: 'data:image/png;base64,aGVsbG8=' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings,
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(propsFn).not.toHaveBeenCalled()
        expect(errors).toEqual({})
        expect(processedInput.media.photo).toBeInstanceOf(ApFile)
    })

    it('passes the value through unprocessed when props() throws, without failing', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const propsFn = vi.fn(async () => {
            throw new Error('third-party API is down')
        })
        const media = { photo: 'data:image/png;base64,aGVsbG8=' }

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(errors).toEqual({})
        expect(processedInput.media).toEqual(media)
        // Marker-first, so the engine's stderr redaction covers the error payload (#403).
        expect(String(logged.mock.calls[0]?.[0])).toContain('[Engine#')
    })

    // Same contract as executeProps: an ENGINE error is a bug and must page, not be passed over.
    it('rethrows an ENGINE ExecutionError from props()', async () => {
        const engineError = new EngineGenericError('BrokenEngine', 'engine bug')
        const propsFn = vi.fn(async () => {
            throw engineError
        })

        await expect(propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { photo: 'data:image/png;base64,aGVsbG8=' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })).rejects.toBe(engineError)
    })

    it('reports a nested validation error for a non-FILE sub-field', async () => {
        const propsFn = vi.fn(async () => ({
            count: Property.Number({ displayName: 'Count', required: true }),
        }))

        const { errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { count: 'not-a-number' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(errors).toEqual({
            media: {
                count: ['Expected number, received: not-a-number'],
            },
        })
    })

    it('reports a failed nested download as a validation error without the URL query', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 401 }))
        const propsFn = vi.fn(async () => ({
            photo: Property.File({ displayName: 'Photo', required: true }),
        }))

        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: { photo: 'https://files.example.com/v1/files/abc?token=secret-jwt' } },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(processedInput.media.photo).toBeNull()
        expect(errors).toEqual({
            media: {
                photo: ['Failed to download file from https://files.example.com/…/abc: HTTP 401'],
            },
        })
        expect(JSON.stringify(errors)).not.toContain('secret-jwt')
    })

    it('does not call props() for a nil value', async () => {
        const propsFn = vi.fn(async () => ({}))

        const { errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media: undefined },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
            propertyContext: PROPERTY_CONTEXT,
        })

        expect(propsFn).not.toHaveBeenCalled()
        expect(errors).toEqual({})
    })

    it('leaves the value alone when no property context is given', async () => {
        const propsFn = vi.fn(async () => ({
            photo: Property.File({ displayName: 'Photo', required: true }),
        }))
        const media = { photo: 'data:image/png;base64,aGVsbG8=' }

        const { processedInput } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { media },
            props: buildProps(propsFn),
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
        })

        expect(propsFn).not.toHaveBeenCalled()
        expect(processedInput.media).toEqual(media)
    })
})

function buildProps(propsFn: () => Promise<InputPropertyMap>): InputPropertyMap {
    return {
        media: Property.DynamicProperties({
            auth: undefined,
            displayName: 'Media',
            required: false,
            refreshers: ['media_type'],
            props: propsFn,
        }),
    }
}

const PROPERTY_CONTEXT: PropertyContext = {
    server: { apiUrl: 'http://127.0.0.1:3000/', publicUrl: 'http://127.0.0.1:4200/api/', token: 'engine-token' },
    project: { id: 'project-1', externalId: async () => undefined },
    flows: {
        list: async () => ({ data: [], next: null, previous: null }),
        current: { id: 'flow-1', version: { id: 'flow-version-1' } },
    },
    connections: { get: async () => null },
}

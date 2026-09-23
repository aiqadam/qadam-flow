import { ApFile, Property, QadamAuth } from '@aiqadam/qadams-framework'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileProcessor } from '../../src/lib/variables/processors/file'
import { PropertyProcessingError } from '../../src/lib/variables/processors/property-processing-error'
import { propsProcessor } from '../../src/lib/variables/props-processor'

const REQUIRED_FILE = Property.File({ displayName: 'File', required: true })
const OPTIONAL_FILE = Property.File({ displayName: 'File', required: false })
const ACCEPTED_FORMS = 'an http(s) URL or a data:<mime>;base64,<data> URI'

describe('fileProcessor', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('data URIs', () => {
        it.each([
            ['audio/mp4', 'm4a'],
            ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
            ['image/svg+xml', 'svg'],
            ['application/x-7z-compressed', '7z'],
        ])('accepts %s', async (mime, extension) => {
            const file = await fileProcessor(REQUIRED_FILE, `data:${mime};base64,aGVsbG8=`)
            expect(file).toBeInstanceOf(ApFile)
            expect(file.filename).toBe(`unknown.${extension}`)
            expect(file.extension).toBe(extension)
            expect(file.data.toString()).toBe('hello')
        })

        it('accepts MIME parameters before ;base64', async () => {
            const file = await fileProcessor(REQUIRED_FILE, 'data:text/plain;charset=utf-8;base64,aGVsbG8=')
            expect(file.filename).toBe('unknown.txt')
            expect(file.data.toString()).toBe('hello')
        })

        it('falls back to .bin for an unknown MIME type', async () => {
            const file = await fileProcessor(REQUIRED_FILE, 'data:application/x-made-up.v2;base64,aGVsbG8=')
            expect(file.filename).toBe('unknown.bin')
        })

        it('rejects a data URI that is not base64-encoded', async () => {
            await expect(fileProcessor(REQUIRED_FILE, 'data:text/plain,hello')).rejects.toThrow(/Invalid data URI/)
        })

        it('rejects a data URI whose payload is not valid base64', async () => {
            await expect(fileProcessor(REQUIRED_FILE, 'data:text/plain;base64,not base64!')).rejects.toThrow(/Invalid data URI/)
        })
    })

    describe('URLs', () => {
        it('downloads an http(s) URL', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<svg/>', {
                status: 200,
                headers: { 'content-type': 'image/svg+xml' },
            }))
            const file = await fileProcessor(REQUIRED_FILE, 'https://example.com/assets/logo.svg')
            expect(file.filename).toBe('logo.svg')
            expect(file.data.toString()).toBe('<svg/>')
        })

        it('fails on a non-2xx status instead of treating the error body as the file', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"message":"unauthorized"}', { status: 401 }))
            const error = await captureError(fileProcessor(REQUIRED_FILE, 'https://api.example.com/v1/files/abc?token=eyJhbGciOiJIUzI1NiJ9.secret'))
            expect(error).toBeInstanceOf(PropertyProcessingError)
            expect(error.message).toBe('Failed to download file from https://api.example.com/…/abc: HTTP 401')
            expect(error.message).not.toContain('eyJhbGciOiJIUzI1NiJ9')
        })

        it('fails on a network error with the reason', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', {
                cause: new Error('getaddrinfo ENOTFOUND files.invalid'),
            }))
            const error = await captureError(fileProcessor(REQUIRED_FILE, 'https://files.invalid/a.png?token=secret'))
            expect(error).toBeInstanceOf(PropertyProcessingError)
            expect(error.message).toBe('Failed to download file from https://files.invalid/a.png: getaddrinfo ENOTFOUND files.invalid')
        })

        it('scrubs a network error message that echoes the URL back', async () => {
            const url = 'https://api.telegram.org/file/bot123456:SECRET-TOKEN/photos/file_1.jpg?token=secret-jwt'
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(`connect failed for ${url} (via https://proxy-user:proxy-pass@proxy.example.com/)`))
            const error = await captureError(fileProcessor(REQUIRED_FILE, url))
            expect(error.message).toBe('Failed to download file from https://api.telegram.org/…/file_1.jpg: connect failed for https://api.telegram.org/…/file_1.jpg (via https://proxy.example.com/)')
        })

        // Telegram's file URLs put the bot token in the path, not the query.
        it('reports only the origin and the file name of the URL', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }))
            const error = await captureError(fileProcessor(REQUIRED_FILE, 'https://api.telegram.org/file/bot123456:SECRET-TOKEN/photos/file_1.jpg'))
            expect(error.message).toBe('Failed to download file from https://api.telegram.org/…/file_1.jpg: HTTP 404')
            expect(error.message).not.toContain('SECRET-TOKEN')
        })

        // Node's fetch throws `Request cannot be constructed from a URL that includes credentials:
        // <full href>` for these, with no cause, so the password would land in the step error.
        it('rejects a URL with embedded credentials before fetching, without echoing them', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch')
            for (const url of ['https://user:hunter2@files.example.com/a.png', 'https://hunter2@files.example.com/a.png']) {
                const error = await captureError(fileProcessor(REQUIRED_FILE, url))
                expect(error).toBeInstanceOf(PropertyProcessingError)
                expect(error.message).toContain('must not embed credentials')
                expect(error.message).not.toContain('hunter2')
            }
            expect(fetchSpy).not.toHaveBeenCalled()
        })

        it('scrubs credentials from the preview of a URL with an unsupported scheme', async () => {
            const error = await captureError(fileProcessor(REQUIRED_FILE, 'ftp://user:hunter2@files.example.com/a.png'))
            expect(error.message).toContain('received: "ftp://files.example.com/a.png"')
            expect(error.message).not.toContain('hunter2')
        })

        it('does not accept schemes other than http(s)', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch')
            await expect(fileProcessor(REQUIRED_FILE, 'file:///etc/passwd')).rejects.toThrow(`Expected a file as ${ACCEPTED_FORMS}`)
            await expect(fileProcessor(REQUIRED_FILE, 'memory://{"fileName":"a.png","data":"aGVsbG8="}')).rejects.toThrow(`Expected a file as ${ACCEPTED_FORMS}`)
            expect(fetchSpy).not.toHaveBeenCalled()
        })
    })

    describe('other values', () => {
        it('rejects an object naming the accepted forms', async () => {
            await expect(fileProcessor(REQUIRED_FILE, { url: 'https://example.com/a.png', filename: 'a.png' }))
                .rejects.toThrow(`Expected a file as ${ACCEPTED_FORMS}, received an object`)
        })

        it('rejects bare base64 without a data: prefix', async () => {
            await expect(fileProcessor(REQUIRED_FILE, 'aGVsbG8=')).rejects.toThrow(`Expected a file as ${ACCEPTED_FORMS}, received: "aGVsbG8="`)
        })

        it.each([null, undefined, ''])('returns null for %j', async (value) => {
            expect(await fileProcessor(OPTIONAL_FILE, value)).toBeNull()
        })
    })
})

describe('propsProcessor FILE errors', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('allows a nil or empty optional file', async () => {
        const { errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { a: null, b: undefined, c: '' },
            props: { a: OPTIONAL_FILE, b: OPTIONAL_FILE, c: OPTIONAL_FILE },
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
        })
        expect(errors).toEqual({})
    })

    it('records a processing failure as the property\'s own error, not the generic validator message', async () => {
        const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators({
            resolvedInput: { file: { url: 'https://example.com/a.png' } },
            props: { file: REQUIRED_FILE },
            auth: QadamAuth.None(),
            requireAuth: false,
            propertySettings: {},
        })
        expect(processedInput.file).toBeNull()
        expect(errors).toEqual({
            file: [`Expected a file as ${ACCEPTED_FORMS}, received an object`],
        })
    })
})

async function captureError(promise: Promise<unknown>): Promise<Error> {
    const result = await promise.then(() => undefined, (error: Error) => error)
    if (result === undefined) {
        throw new Error('Expected the promise to reject')
    }
    return result
}

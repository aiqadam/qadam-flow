import { ApFile } from '@aiqadam/qadams-framework'
import { isBase64, isNil, isString, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { PropertyProcessingError } from './property-processing-error'
import { ProcessorFn } from './types'

export const FILE_VALUE_FORMS = 'an http(s) URL or a data:<mime>;base64,<data> URI'

export const fileProcessor: ProcessorFn = async (_property, value) => {
    if (isNil(value) || value === '') {
        return null
    }
    if (!isString(value)) {
        throw new PropertyProcessingError({ message: `Expected a file as ${FILE_VALUE_FORMS}, received ${describeNonString(value)}` })
    }
    if (DATA_URI_PREFIX.test(value)) {
        return parseDataUri(value)
    }
    const url = parseHttpUrl(value)
    if (isNil(url)) {
        throw new PropertyProcessingError({ message: `Expected a file as ${FILE_VALUE_FORMS}, received: "${previewString(value)}"` })
    }
    // fetch refuses such a URL anyway, and its error message echoes the whole href — password
    // included — into the step error, which is persisted and shown to anyone who can open the run.
    if (url.username !== '' || url.password !== '') {
        throw new PropertyProcessingError({ message: 'A file URL must not embed credentials (user:password@host); put them in a header or a signed URL instead' })
    }
    return downloadFile(url)
}

function parseDataUri(value: string): ApFile {
    const matches = DATA_URI_REGEX.exec(value)
    if (isNil(matches) || !isBase64(matches[2])) {
        throw new PropertyProcessingError({ message: 'Invalid data URI: expected data:<mime>[;name=value];base64,<base64 data>' })
    }
    const extension = mimeExtension(matches[1]) ?? 'bin'
    return new ApFile(
        `unknown.${extension}`,
        Buffer.from(matches[2], 'base64'),
        extension,
    )
}

function parseHttpUrl(value: string): URL | null {
    const { data: url } = tryCatchSync(() => new URL(value))
    if (isNil(url) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
        return null
    }
    return url
}

async function downloadFile(url: URL): Promise<ApFile> {
    const location = describeLocation(url)
    const { data: response, error: fetchError } = await tryCatch(() => fetch(url))
    if (isNil(response)) {
        throw new PropertyProcessingError({ message: `Failed to download file from ${location}: ${describeFetchError({ error: fetchError, url })}`, cause: fetchError })
    }
    if (!response.ok) {
        await tryCatch(async () => response.body?.cancel())
        throw new PropertyProcessingError({ message: `Failed to download file from ${location}: HTTP ${response.status}` })
    }
    const { data: body, error: bodyError } = await tryCatch(() => response.arrayBuffer())
    if (isNil(body)) {
        throw new PropertyProcessingError({ message: `Failed to download file from ${location}: ${describeFetchError({ error: bodyError, url })}`, cause: bodyError })
    }
    const filename = getFileName({
        url,
        disposition: response.headers.get('content-disposition'),
        mimeType: response.headers.get('content-type') ?? undefined,
    }) ?? 'unknown'
    const extension = filename.split('.').length > 1 ? filename.split('.').pop() : undefined
    return new ApFile(
        filename,
        Buffer.from(body),
        extension,
    )
}

// A step error is persisted and shown to anyone who can open the run, and a file URL is a bearer
// credential in more places than its query: platform file URLs carry `?token=<JWT>`, and Telegram's
// are `api.telegram.org/file/bot<token>/<path>`. Only the origin and the file name survive.
function describeLocation(url: URL): string {
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
    const lastSegment = segments[segments.length - 1] ?? ''
    return `${url.origin}${segments.length > 1 ? '/…/' : '/'}${lastSegment}`
}

// undici reports every network failure as `TypeError: fetch failed` and keeps the reason
// (ECONNREFUSED, ENOTFOUND, an SSRF block) on `cause`. Either may quote the URL back.
function describeFetchError({ error, url }: { error: unknown, url: URL }): string {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    const message = cause instanceof Error ? cause.message : String(cause)
    const location = describeLocation(url)
    const withoutHref = replaceAll({ text: message, search: url.href, replacement: location })
    const withoutPath = replaceAll({ text: withoutHref, search: `${url.origin}${url.pathname}`, replacement: location })
    return scrubUserinfo(replaceAll({ text: withoutPath, search: url.search, replacement: '' }))
}

function replaceAll({ text, search, replacement }: { text: string, search: string, replacement: string }): string {
    return search.length > 0 ? text.split(search).join(replacement) : text
}

function scrubUserinfo(text: string): string {
    return text.replace(USERINFO_REGEX, '//')
}

function describeNonString(value: unknown): string {
    if (Array.isArray(value)) {
        return 'an array'
    }
    if (typeof value === 'object') {
        return 'an object'
    }
    return `a ${typeof value}`
}

function previewString(value: string): string {
    const withoutQuery = scrubUserinfo(value.split('?')[0])
    return withoutQuery.length > PREVIEW_LENGTH ? `${withoutQuery.slice(0, PREVIEW_LENGTH)}…` : withoutQuery
}

function getFileName({ url, disposition, mimeType }: { url: URL, disposition: string | null, mimeType: string | undefined }): string | null {
    if (isNil(disposition)) {
        const fileNameFromUrl = url.pathname.includes('/') && url.pathname.split('/').pop()?.includes('.') ? url.pathname.split('/').pop() : null
        if (!isNil(fileNameFromUrl)) {
            return fileNameFromUrl
        }
        const resolvedExtension = mimeType ? mimeExtension(mimeType) : null
        return `unknown.${resolvedExtension ?? 'bin'}`
    }
    const utf8FilenameRegex = /filename\*=UTF-8''([\w%\-.]+)(?:; ?|$)/i
    if (utf8FilenameRegex.test(disposition)) {
        const result = utf8FilenameRegex.exec(disposition)
        if (result && result.length > 1) {
            return decodeURIComponent(result[1])
        }
    }
    // prevent ReDos attacks by anchoring the ascii regex to string start and
    // slicing off everything before 'filename='
    const filenameStart = disposition.toLowerCase().indexOf('filename=')
    const asciiFilenameRegex = /^filename=(["']?)(.*?[^\\])\1(?:; ?|$)/i

    if (filenameStart >= 0) {
        const partialDisposition = disposition.slice(filenameStart)
        const matches = asciiFilenameRegex.exec(partialDisposition)
        if (matches != null && matches[2]) {
            return matches[2]
        }
    }
    return null
}

function mimeExtension(mimeType: string): string | null {
    const normalized = mimeType.split(';')[0].trim().toLowerCase()
    return MIME_EXTENSIONS[normalized] ?? null
}

const DATA_URI_PREFIX = /^data:/i
// RFC 2045 token characters for type, subtype and parameter names, so `audio/mp4`,
// `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `;charset=utf-8` all match.
const DATA_URI_REGEX = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)(?:;[A-Za-z0-9!#$&^_.+-]+=[^;,]*)*;base64,(.+)$/i
const PREVIEW_LENGTH = 40
// `scheme://user:password@host` → `scheme://host`, wherever a URL appears inside a message.
const USERINFO_REGEX = /\/\/[^/\s@]*@/g

const MIME_EXTENSIONS: Record<string, string> = {
    'application/json': 'json',
    'application/pdf': 'pdf',
    'application/xml': 'xml',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/octet-stream': 'bin',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/rtf': 'rtf',
    'application/javascript': 'js',
    'application/x-javascript': 'js',
    'application/x-yaml': 'yaml',
    'application/yaml': 'yaml',
    'application/x-httpd-php': 'php',
    'application/x-sh': 'sh',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/csv': 'csv',
    'text/javascript': 'js',
    'text/markdown': 'md',
    'text/xml': 'xml',
    'text/tab-separated-values': 'tsv',
    'text/yaml': 'yaml',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'weba',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/ogg': 'ogv',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
}
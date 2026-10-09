import { constants as fsConstants } from 'node:fs'
import { FileHandle, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { safeHttp } from '@aiqadam/server-utils'
import { isNil, tryCatch } from '@aiqadam/shared'
import type { AxiosInstance } from 'axios'

// Where a qadam version catalogue is read from. Two kinds, one interface, so the reader does not
// care which: a directory (the snapshot a `:slim` image carries, #807, or a mirror on disk) and an
// HTTP(S) base URL (GitHub Pages by default, or a mirror). Paths handed in are relative to the
// catalogue root and built by the reader from validated coordinates; each source still refuses one
// that would leave its root.
export const qadamVersionCatalogueSource = {
    // Containment is checked on real paths, so a symlink present in the tree cannot lead out of the
    // root. That holds barring a concurrent writer inside the root: a directory swapped for a symlink
    // between `realpath` and `open` is not caught (only the final component is opened `O_NOFOLLOW`).
    // The file is opened without blocking, so a FIFO cannot hang the read, and only a regular file of
    // at most `maxBytes` is read, never past its size.
    directory: ({ root }: { root: string }): QadamVersionCatalogueSource => {
        const resolvedRoot = path.resolve(root)
        return {
            read: async ({ relativePath, maxBytes }): Promise<QadamVersionCatalogueSourceReadResult> => {
                if (!isInside({ root: resolvedRoot, target: path.resolve(resolvedRoot, relativePath) })) {
                    return OUTSIDE_ROOT
                }
                const { data: realRoot, error: rootError } = await tryCatch(() => realpath(resolvedRoot))
                if (rootError) {
                    return fsErrorResult({ error: rootError })
                }
                const { data: realTarget, error: targetError } = await tryCatch(() => realpath(path.resolve(resolvedRoot, relativePath)))
                if (targetError) {
                    return fsErrorResult({ error: targetError })
                }
                if (!isInside({ root: realRoot, target: realTarget })) {
                    return OUTSIDE_ROOT
                }
                const { data: handle, error: openError } = await tryCatch(() => open(realTarget, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK))
                if (openError) {
                    return fsErrorResult({ error: openError })
                }
                const { data: read, error: readError } = await tryCatch(() => readBounded({ handle, maxBytes }))
                // Read-only: a failed close loses nothing, and must not turn a result into a throw.
                await tryCatch(() => handle.close())
                if (readError) {
                    return { status: 'error', reason: errorCode({ error: readError }) ?? 'unreadable' }
                }
                return read
            },
        }
    },

    // Through `safeHttp` (`.agents/rules/safe-http.md`): the URL is operator configuration, so a
    // mirror on a private address needs `AP_SSRF_ALLOW_LIST`, like any other configured endpoint.
    // Errors carry a code, never the URL: a mirror URL may hold credentials.
    http: ({ baseUrl, client = safeHttp.axios }: HttpSourceParams): QadamVersionCatalogueSource => {
        const base = parseBaseUrl({ baseUrl })
        return {
            read: async ({ relativePath, maxBytes }): Promise<QadamVersionCatalogueSourceReadResult> => {
                if (isNil(base)) {
                    return { status: 'error', reason: 'invalid base URL' }
                }
                const url = new URL(relativePath, base)
                if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
                    return { status: 'error', reason: 'path outside the catalogue root' }
                }
                const { data: response, error } = await tryCatch(() => client.request<ArrayBuffer>({
                    method: 'GET',
                    url: url.toString(),
                    responseType: 'arraybuffer',
                    timeout: HTTP_TIMEOUT_MS,
                    maxContentLength: maxBytes,
                    maxRedirects: MAX_REDIRECTS,
                    validateStatus: () => true,
                }))
                if (error) {
                    return { status: 'error', reason: isOverMaxContentLength({ error }) ? TOO_LARGE_REASON : errorCode({ error }) ?? 'request failed' }
                }
                if (response.status === 404) {
                    return { status: 'not-found' }
                }
                if (response.status !== 200) {
                    return { status: 'error', reason: `HTTP ${response.status}` }
                }
                const bytes = Buffer.from(response.data)
                return bytes.length > maxBytes ? { status: 'error', reason: TOO_LARGE_REASON } : { status: 'ok', bytes }
            },
        }
    },
}

const HTTP_TIMEOUT_MS = 30_000

const TOO_LARGE_REASON = 'too large'

const OUTSIDE_ROOT: QadamVersionCatalogueSourceReadResult = { status: 'error', reason: 'path outside the catalogue root' }

// GitHub Pages answers a file directly; a mirror behind a CDN may redirect once or twice. The
// filtering agent is applied again on every hop.
const MAX_REDIRECTS = 3

function parseBaseUrl({ baseUrl }: { baseUrl: string }): URL | null {
    const parsed = URL.canParse(baseUrl) ? new URL(baseUrl) : null
    if (isNil(parsed) || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        return null
    }
    // A base without a trailing slash would resolve `index.json` against its parent directory. The
    // slash is added by setting `pathname`, never by resolving the path as a URL again: a path that
    // starts with `//` or `/\` would be re-read as protocol-relative and replace the host.
    if (!parsed.pathname.endsWith('/')) {
        parsed.pathname = `${parsed.pathname}/`
    }
    return parsed
}

function isInside({ root, target }: { root: string, target: string }): boolean {
    const relative = path.relative(root, target)
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

// The size on the descriptor is checked first, and the read itself stops one byte past that size,
// so a file that grows after `fstat` is refused rather than read without a bound.
async function readBounded({ handle, maxBytes }: { handle: FileHandle, maxBytes: number }): Promise<QadamVersionCatalogueSourceReadResult> {
    const stats = await handle.stat()
    if (!stats.isFile()) {
        return { status: 'error', reason: 'not a regular file' }
    }
    if (stats.size > maxBytes) {
        return { status: 'error', reason: TOO_LARGE_REASON }
    }
    const buffer = Buffer.alloc(stats.size + 1)
    let length = 0
    while (length < buffer.length) {
        const { bytesRead } = await handle.read({ buffer, offset: length, length: buffer.length - length, position: length })
        if (bytesRead === 0) {
            break
        }
        length += bytesRead
    }
    return length === stats.size ? { status: 'ok', bytes: buffer.subarray(0, length) } : { status: 'error', reason: 'changed while read' }
}

function fsErrorResult({ error }: { error: unknown }): QadamVersionCatalogueSourceReadResult {
    const code = errorCode({ error })
    return code === 'ENOENT' ? { status: 'not-found' } : { status: 'error', reason: code ?? 'unreadable' }
}

// axios rejects a body over `maxContentLength` with a generic `ERR_BAD_RESPONSE`; the message is the
// only thing that tells it apart from a broken response.
function isOverMaxContentLength({ error }: { error: unknown }): boolean {
    return errorCode({ error }) === 'ERR_BAD_RESPONSE' && error instanceof Error && error.message.startsWith('maxContentLength')
}

function errorCode({ error }: { error: unknown }): string | undefined {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
        return error.code
    }
    return undefined
}

type HttpSourceParams = {
    baseUrl: string
    client?: AxiosInstance
}

export type QadamVersionCatalogueSourceReadResult =
    | { status: 'ok', bytes: Buffer }
    | { status: 'not-found' }
    | { status: 'error', reason: string }

export type QadamVersionCatalogueSource = {
    read: (params: { relativePath: string, maxBytes: number }) => Promise<QadamVersionCatalogueSourceReadResult>
}

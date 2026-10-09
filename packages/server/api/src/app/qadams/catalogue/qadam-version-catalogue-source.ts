import { FileHandle, open } from 'node:fs/promises'
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
    directory: ({ root }: { root: string }): QadamVersionCatalogueSource => {
        const resolvedRoot = path.resolve(root)
        return {
            kind: 'directory',
            read: async ({ relativePath, maxBytes }): Promise<QadamVersionCatalogueSourceReadResult> => {
                const target = path.resolve(resolvedRoot, relativePath)
                if (!isInside({ root: resolvedRoot, target })) {
                    return { status: 'error', reason: 'path outside the catalogue root' }
                }
                const { data: handle, error: openError } = await tryCatch(() => open(target, 'r'))
                if (openError) {
                    return errorCode({ error: openError }) === 'ENOENT' ? { status: 'not-found' } : { status: 'error', reason: errorCode({ error: openError }) ?? 'unreadable' }
                }
                try {
                    const { data: bytes, error: readError } = await tryCatch(() => readBounded({ handle, maxBytes }))
                    if (readError) {
                        return { status: 'error', reason: errorCode({ error: readError }) ?? 'unreadable' }
                    }
                    return isNil(bytes) ? { status: 'error', reason: 'too large' } : { status: 'ok', bytes }
                }
                finally {
                    await handle.close()
                }
            },
        }
    },

    // Through `safeHttp` (`.agents/rules/safe-http.md`): the URL is operator configuration, so a
    // mirror on a private address needs `AP_SSRF_ALLOW_LIST`, like any other configured endpoint.
    // Errors carry a code, never the URL: a mirror URL may hold credentials.
    http: ({ baseUrl, client = safeHttp.axios }: HttpSourceParams): QadamVersionCatalogueSource => {
        const base = parseBaseUrl({ baseUrl })
        return {
            kind: 'http',
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
                    return { status: 'error', reason: errorCode({ error }) ?? 'request failed' }
                }
                if (response.status === 404) {
                    return { status: 'not-found' }
                }
                if (response.status !== 200) {
                    return { status: 'error', reason: `HTTP ${response.status}` }
                }
                const bytes = Buffer.from(response.data)
                return bytes.length > maxBytes ? { status: 'error', reason: 'too large' } : { status: 'ok', bytes }
            },
        }
    },
}

const HTTP_TIMEOUT_MS = 30_000

// GitHub Pages answers a file directly; a mirror behind a CDN may redirect once or twice. The
// filtering agent is applied again on every hop.
const MAX_REDIRECTS = 3

function parseBaseUrl({ baseUrl }: { baseUrl: string }): URL | null {
    const parsed = URL.canParse(baseUrl) ? new URL(baseUrl) : null
    if (isNil(parsed) || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
        return null
    }
    // A base without a trailing slash would resolve `index.json` against its parent directory.
    return parsed.pathname.endsWith('/') ? parsed : new URL(`${parsed.pathname}/`, parsed)
}

function isInside({ root, target }: { root: string, target: string }): boolean {
    const relative = path.relative(root, target)
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

// `null` when the file is larger than `maxBytes`, checked on the open descriptor before reading and
// again on what was read.
async function readBounded({ handle, maxBytes }: { handle: FileHandle, maxBytes: number }): Promise<Buffer | null> {
    const { size } = await handle.stat()
    if (size > maxBytes) {
        return null
    }
    const bytes = await handle.readFile()
    return bytes.length > maxBytes ? null : bytes
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
    kind: 'directory' | 'http'
    read: (params: { relativePath: string, maxBytes: number }) => Promise<QadamVersionCatalogueSourceReadResult>
}

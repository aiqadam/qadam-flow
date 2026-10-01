import { promisify } from 'node:util'
import { zstdDecompress as zstdDecompressCallback } from 'node:zlib'
import { EngineGenericError, FileCompression, FileType, isZstdCompressed } from '@aiqadam/shared'
import { retryingFetch, RetryPolicy } from './retrying-fetch'

const zstdDecompress = promisify(zstdDecompressCallback)

const READ_URL_HEADER = 'x-ap-file-read-url'
const FILE_TYPE_HEADER = 'x-ap-file-type'
const FILE_NAME_HEADER = 'x-ap-file-name'

export const engineFileApi = {
    // Both PUTs are replayed on a failure that may have landed: the app's upload writes the same bytes
    // to the same file id of the engine's own project (#517 refuses another project's row), and a
    // signed S3 PUT is idempotent by definition.
    async upload({ engineToken, apiUrl, fileId, type, fileName, compression, data, retryPolicy }: UploadParams): Promise<UploadResult> {
        const headers = buildPutHeaders({ type, fileName, compression, contentLength: data.length })
        const putUrl = `${apiUrl}v1/files/${fileId}?token=${encodeURIComponent(engineToken)}`

        const initial = await retryingFetch.fetch({
            url: putUrl,
            init: {
                method: 'PUT',
                body: data,
                headers,
                redirect: 'manual',
            },
            idempotent: true,
            policy: retryPolicy,
        })

        const readUrlFromHeader = initial.headers.get(READ_URL_HEADER) ?? undefined

        if (initial.status >= 300 && initial.status < 400) {
            const location = initial.headers.get('location')
            if (!location) {
                throw new EngineGenericError('EngineFileUploadError', 'Server returned a redirect without a Location header')
            }
            const s3Response = await retryingFetch.fetch({
                url: location,
                init: {
                    method: 'PUT',
                    body: data,
                    headers: stripApHeaders(headers),
                    redirect: 'follow',
                },
                idempotent: true,
                policy: retryPolicy,
            })
            if (!s3Response.ok) {
                throw new EngineGenericError(
                    'EngineFileUploadError',
                    `Failed to upload to signed S3 URL for ${fileId}: ${s3Response.status} ${s3Response.statusText}`,
                )
            }
            if (!readUrlFromHeader) {
                throw new EngineGenericError('EngineFileUploadError', `Server redirect response missing ${READ_URL_HEADER} header`)
            }
            return { fileId, readUrl: readUrlFromHeader }
        }

        if (!initial.ok) {
            throw new EngineGenericError(
                'EngineFileUploadError',
                `Failed to upload engine file ${fileId}: ${initial.status} ${initial.statusText}`,
            )
        }

        if (readUrlFromHeader) {
            return { fileId, readUrl: readUrlFromHeader }
        }
        const body = await initial.json() as { readUrl?: unknown }
        if (typeof body.readUrl !== 'string') {
            throw new EngineGenericError('EngineFileUploadError', 'Upload response missing readUrl')
        }
        return { fileId, readUrl: body.readUrl }
    },
    async download({ engineToken, apiUrl, fileId, retryPolicy }: DownloadFileParams): Promise<Uint8Array> {
        const response = await retryingFetch.fetch({
            url: `${apiUrl}v1/files/${fileId}?token=${encodeURIComponent(engineToken)}`,
            init: {
                method: 'GET',
                redirect: 'follow',
            },
            idempotent: true,
            policy: retryPolicy,
        })
        if (!response.ok) {
            throw new EngineGenericError(
                'EngineFileDownloadError',
                `Failed to download file ${fileId}: ${response.status} ${response.statusText}`,
            )
        }
        const raw = new Uint8Array(await response.arrayBuffer())
        // The server's proxy path runs the file through fileCompressor.decompress before
        // streaming it back, but the S3 signed-URL redirect path serves the stored bytes
        // straight from S3 — which for FLOW_RUN_LOG is zstd-compressed. Native fetch does
        // not auto-decompress zstd, so callers (RESUME hydration, slice materialization)
        // would crash on JSON.parse. Detect the magic bytes and decompress here so the
        // download contract is "always returns the original payload" regardless of which
        // server path served it.
        if (isZstdCompressed(raw)) {
            return new Uint8Array(await zstdDecompress(Buffer.from(raw)))
        }
        return raw
    },
}

function buildPutHeaders({ type, fileName, compression, contentLength }: BuildHeadersParams): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(contentLength),
        [FILE_TYPE_HEADER]: type,
    }
    if (fileName) {
        // HTTP headers are ByteStrings — any non-ASCII byte (Cyrillic, CJK,
        // emoji) crashes undici with "Cannot convert argument to a ByteString".
        // Percent-encode on the wire; the server calls decodeURIComponent.
        headers[FILE_NAME_HEADER] = encodeURIComponent(fileName)
    }
    if (compression === FileCompression.ZSTD) {
        headers['Content-Encoding'] = 'zstd'
    }
    return headers
}

function stripApHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (!key.toLowerCase().startsWith('x-ap-')) {
            result[key] = value
        }
    }
    return result
}

type UploadParams = {
    engineToken: string
    apiUrl: string
    fileId: string
    type: FileType.FLOW_STEP_FILE | FileType.FLOW_RUN_LOG | FileType.FLOW_RUN_LOG_SLICE
    fileName?: string
    compression?: FileCompression
    data: Uint8Array | Buffer
    retryPolicy?: RetryPolicy
}

type UploadResult = {
    fileId: string
    readUrl: string
}

type DownloadFileParams = {
    engineToken: string
    apiUrl: string
    fileId: string
    retryPolicy?: RetryPolicy
}

type BuildHeadersParams = {
    type: FileType
    fileName?: string
    compression?: FileCompression
    contentLength: number
}

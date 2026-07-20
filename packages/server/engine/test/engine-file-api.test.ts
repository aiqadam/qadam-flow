import { promisify } from 'node:util'
import { zstdCompress as zstdCompressCallback } from 'node:zlib'
import { FileType } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineFileApi } from '../src/lib/engine-file-api'

const zstdCompress = promisify(zstdCompressCallback)

const PARAMS = {
    engineToken: 'test-token',
    apiUrl: 'http://localhost:3000/',
    fileId: 'file-1',
}

describe('engineFileApi.download zstd auto-decompression', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns plain bytes untouched when the server already decompressed', async () => {
        const plain = new TextEncoder().encode(JSON.stringify({ hello: 'world' }))
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(plain, { status: 200 }))

        const bytes = await engineFileApi.download(PARAMS)

        expect(new TextDecoder().decode(bytes)).toBe('{"hello":"world"}')
    })

    it('#37: percent-encodes non-ASCII fileName in x-ap-file-name header', async () => {
        const captured: { headers?: Record<string, string> } = {}
        vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            captured.headers = init?.headers as Record<string, string>
            return new Response(JSON.stringify({ readUrl: 'http://x/y' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        await engineFileApi.upload({
            ...PARAMS,
            type: FileType.FLOW_STEP_FILE,
            fileName: 'ил_1100.doc',
            data: Buffer.from('cyrillic content'),
        })

        expect(captured.headers?.['x-ap-file-name']).toBe(encodeURIComponent('ил_1100.doc'))
        expect(decodeURIComponent(captured.headers?.['x-ap-file-name'] ?? '')).toBe('ил_1100.doc')
    })

    it('#37: passes ASCII fileName through encodeURIComponent unchanged (safe chars)', async () => {
        const captured: { headers?: Record<string, string> } = {}
        vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            captured.headers = init?.headers as Record<string, string>
            return new Response(JSON.stringify({ readUrl: 'http://x/y' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        await engineFileApi.upload({
            ...PARAMS,
            type: FileType.FLOW_STEP_FILE,
            fileName: 'hello.txt',
            data: Buffer.from('x'),
        })

        expect(captured.headers?.['x-ap-file-name']).toBe('hello.txt')
    })

    it('decompresses raw zstd bytes — covers the S3 signed-URL redirect path on RESUME', async () => {
        // Simulates the path where the server 307s to S3 and the engine receives the
        // file exactly as it was uploaded — zstd-compressed for FLOW_RUN_LOG.
        const original = Buffer.from(JSON.stringify({ executionState: { steps: { trigger: { output: { ok: true } } }, tags: [] } }))
        const compressed = await zstdCompress(original)
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array(compressed), { status: 200 }))

        const bytes = await engineFileApi.download(PARAMS)

        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
            executionState: { steps: { trigger: { output: { ok: true } } }, tags: [] },
        })
    })
})

import http from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatAiUtils } from '../src/chat-ai-utils'

// Loopback is exactly what the SSRF filter blocks, so a local fixture server is unreachable
// without this. See `safe-http-fetch.test.ts` for why this has to live in its own file: the axios
// singleton reads the allow list once, lazily, on first use.
process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'

let server: http.Server
let baseUrl: string

beforeAll(async () => {
    server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('file-bytes')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
})

// #942: this is what `streamText`'s `experimental_download` calls instead of the AI SDK's own
// `fetchUntrustedUrl`, so any `file`-part URL in a chat turn — a tool result, not just a user
// attachment — goes through the same SSRF filter as every other outbound request this process
// makes, not a second, unfiltered implementation.
describe('chatAiUtils.createSafeDownloadFunction', () => {
    it('downloads an allow-listed URL through the SSRF-filtered client', async () => {
        const download = chatAiUtils.createSafeDownloadFunction()

        const [result] = await download([{ url: new URL(`${baseUrl}/x.png`), isUrlSupportedByModel: false }])

        expect(result?.mediaType).toBe('image/png')
        expect(new TextDecoder().decode(result?.data)).toBe('file-bytes')
    })

    it('skips a URL the model already declares support for, like the SDK default does', async () => {
        const download = chatAiUtils.createSafeDownloadFunction()

        const [result] = await download([{ url: new URL(`${baseUrl}/x.png`), isUrlSupportedByModel: true }])

        expect(result).toBeNull()
    })

    it('blocks a cloud-metadata address instead of handing it to the model provider', async () => {
        const download = chatAiUtils.createSafeDownloadFunction()

        await expect(download([{ url: new URL('http://169.254.169.254/latest/meta-data/'), isUrlSupportedByModel: false }]))
            .rejects.toThrow()
    })

    it('aborts an in-flight download when the chat run is cancelled', async () => {
        const controller = new AbortController()
        const download = chatAiUtils.createSafeDownloadFunction(controller.signal)
        controller.abort()

        await expect(download([{ url: new URL(`${baseUrl}/x.png`), isUrlSupportedByModel: false }]))
            .rejects.toThrow()
    })
})

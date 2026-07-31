import http from 'node:http'
import { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'

// Loopback is exactly what the SSRF filter blocks, so a local fixture server is unreachable
// without this. Assigning after the import is still early enough: the axios instance is built
// lazily on first use and reads the allow list once, at construction, and nothing touches it at
// import time. Kept in its own file so no other suite can consume the singleton first — the
// success cases below fail outright if this does not take effect, so the arrangement checks itself.
process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

let server: http.Server
let baseUrl: string
let handler: Handler

beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
})

describe('safeHttp.fetch', () => {
    it('returns a readable Response for a 200', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ hello: 'world' }))
        }

        const response = await safeHttp.fetch(`${baseUrl}/ok`)

        expect(response.ok).toBe(true)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual({ hello: 'world' })
    })

    it('forwards method, headers and body on a POST', async () => {
        const seen: { method?: string, auth?: string, body?: string } = {}
        handler = (req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
                seen.method = req.method
                seen.auth = req.headers['authorization']
                seen.body = Buffer.concat(chunks).toString()
                res.writeHead(200).end('done')
            })
        }

        await safeHttp.fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: { 'authorization': 'Bearer secret-key', 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'hi' }),
        })

        expect(seen).toEqual({
            method: 'POST',
            auth: 'Bearer secret-key',
            body: '{"prompt":"hi"}',
        })
    })

    // The whole point of `responseType: 'stream'`: a token stream must be readable before the
    // provider closes the connection, or every chat reply lands as one lump at the end.
    it('exposes the body incrementally instead of buffering the whole response', async () => {
        let releaseSecondChunk: () => void = () => {}
        const secondChunkSent = new Promise<void>((resolve) => {
            releaseSecondChunk = resolve
        })
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: first\n\n')
            void secondChunkSent.then(() => res.end('data: second\n\n'))
        }

        const response = await safeHttp.fetch(`${baseUrl}/stream`)
        const reader = response.body!.getReader()

        const first = await reader.read()
        expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')

        releaseSecondChunk()
        const second = await reader.read()
        expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n')
    })

    // `fetch` semantics: only transport failures reject. The AI SDK reads provider error bodies
    // off 4xx responses to build its own errors, so throwing here would lose the message.
    it('resolves rather than throws on a 4xx, keeping the error body readable', async () => {
        handler = (_req, res) => {
            res.writeHead(429, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'rate limited' }))
        }

        const response = await safeHttp.fetch(`${baseUrl}/limited`)

        expect(response.ok).toBe(false)
        expect(response.status).toBe(429)
        await expect(response.json()).resolves.toEqual({ error: 'rate limited' })
    })

    it('does not describe a decompressed body with the wire response encoding', async () => {
        const payload = JSON.stringify({ compressed: true })
        handler = (_req, res) => {
            const gzipped = gzipSync(Buffer.from(payload))
            res.writeHead(200, {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': String(gzipped.byteLength),
            })
            res.end(gzipped)
        }

        const response = await safeHttp.fetch(`${baseUrl}/gzip`)

        await expect(response.text()).resolves.toBe(payload)
        expect(response.headers.get('content-encoding')).toBeNull()
        expect(response.headers.get('content-length')).toBeNull()
    })

    it('returns a null body for a 204 instead of throwing on the Response constructor', async () => {
        handler = (_req, res) => res.writeHead(204).end()

        const response = await safeHttp.fetch(`${baseUrl}/empty`, { method: 'POST' })

        expect(response.status).toBe(204)
        expect(response.body).toBeNull()
    })

    it('rejects when the caller aborts before the response headers arrive', async () => {
        handler = () => {}
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 50)

        await expect(safeHttp.fetch(`${baseUrl}/hang`, { signal: controller.signal })).rejects.toThrow()
    })

    // How a cancelled chat turn actually stops the provider: the response has already begun, so
    // the abort has to tear down the body stream rather than the request promise.
    it('errors the body stream when the caller aborts mid-response', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: first\n\n')
        }
        const controller = new AbortController()

        const response = await safeHttp.fetch(`${baseUrl}/cancel`, { signal: controller.signal })
        const reader = response.body!.getReader()
        await reader.read()

        controller.abort()
        await expect(reader.read()).rejects.toThrow()
    })

    it('gives a HEAD response a null body, as fetch does', async () => {
        handler = (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end()

        const response = await safeHttp.fetch(`${baseUrl}/head`, { method: 'HEAD' })

        expect(response.status).toBe(200)
        expect(response.body).toBeNull()
    })

    it('sends no body on a GET even when one is technically constructible', async () => {
        let sawContentLength: string | undefined
        handler = (req, res) => {
            sawContentLength = req.headers['content-length']
            res.writeHead(200).end('ok')
        }

        await safeHttp.fetch(`${baseUrl}/get`)

        expect(sawContentLength).toBeUndefined()
    })

    it('carries the status text through', async () => {
        handler = (_req, res) => res.writeHead(418, 'I am a teapot').end('nope')

        const response = await safeHttp.fetch(`${baseUrl}/teapot`)

        expect(response.statusText).toBe('I am a teapot')
    })

    it('gives a 304 a null body, not only a 204', async () => {
        handler = (_req, res) => res.writeHead(304).end()

        const response = await safeHttp.fetch(`${baseUrl}/not-modified`)

        expect(response.status).toBe(304)
        expect(response.body).toBeNull()
    })

    it('keeps repeated set-cookie headers separate instead of comma-joining them', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] }).end('ok')
        }

        const response = await safeHttp.fetch(`${baseUrl}/cookies`)

        expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    })

    it('drops framing headers that describe a connection the caller never sees', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: one\n\n')
            res.end()
        }

        const response = await safeHttp.fetch(`${baseUrl}/framing`)
        await response.text()

        expect(response.headers.get('transfer-encoding')).toBeNull()
        expect(response.headers.get('connection')).toBeNull()
    })

    describe('redirects', () => {
        function redirectingHandler(): Handler {
            return (req, res) => {
                if (req.url === '/start') {
                    res.writeHead(302, { location: `${baseUrl}/dest` }).end()
                    return
                }
                res.writeHead(200).end('arrived')
            }
        }

        it('follows a redirect by default', async () => {
            handler = redirectingHandler()

            const response = await safeHttp.fetch(`${baseUrl}/start`)

            await expect(response.text()).resolves.toBe('arrived')
        })

        it('does not follow when the caller asks for manual redirects', async () => {
            handler = redirectingHandler()

            const response = await safeHttp.fetch(`${baseUrl}/start`, { redirect: 'manual' })

            expect(response.status).toBe(302)
            expect(response.headers.get('location')).toBe(`${baseUrl}/dest`)
        })

        it('rejects rather than silently following when the caller asks for redirect: error', async () => {
            handler = redirectingHandler()

            await expect(safeHttp.fetch(`${baseUrl}/start`, { redirect: 'error' })).rejects.toThrow(/not supported/)
        })
    })

    describe('error handling', () => {
        // The AI SDK's retry loop only recognises DOMException/AbortError; axios' own CanceledError
        // would make a cancelled chat turn look like a provider failure worth retrying.
        it('reports an abort as an AbortError, not as an axios CanceledError', async () => {
            handler = () => {}
            const controller = new AbortController()
            setTimeout(() => controller.abort(), 50)

            await expect(safeHttp.fetch(`${baseUrl}/hang`, { signal: controller.signal }))
                .rejects.toMatchObject({ name: 'AbortError' })
        })

        // An AxiosError carries the request config, and the request config carries the provider's
        // API key. Anything that logs the error would print it.
        it('does not let the request headers escape on a transport failure', async () => {
            const apiKey = 'sk-super-secret-key'
            // A port nothing is listening on, so the request fails at connect time.
            const deadUrl = 'http://127.0.0.1:1/v1/messages'

            const error = await safeHttp.fetch(deadUrl, {
                method: 'POST',
                headers: { 'x-api-key': apiKey, 'authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ prompt: 'secret prompt' }),
            }).then(() => null, (err: unknown) => err)

            expect(error).toBeInstanceOf(Error)
            expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(apiKey)
            expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('secret prompt')
            expect(error).not.toHaveProperty('config')
        })
    })

    // The idle timeout is load-bearing and easy to get wrong: axios implements `timeout` as
    // `req.setTimeout`, a socket-inactivity timer, so it must NOT cut off a long stream that keeps
    // producing. Probed here at a short value against the same client, because asserting it at the
    // real 120s is not a test anyone would run.
    it('treats the timeout as socket inactivity, so a slow but active stream survives it', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            let sent = 0
            const timer = setInterval(() => {
                res.write(`data: ${sent}\n\n`)
                if (++sent === 6) {
                    clearInterval(timer)
                    res.end()
                }
            }, 100)
        }

        const instance = safeHttp.createAxios({ timeout: 250, responseType: 'stream' })
        const response = await instance.get<Readable>(`${baseUrl}/slow-stream`)
        const chunks: Buffer[] = []
        for await (const chunk of response.data) {
            chunks.push(Buffer.from(chunk))
        }

        // Total duration ~600ms against a 250ms timeout: only an inactivity timer lets this pass.
        expect(Buffer.concat(chunks).toString()).toContain('data: 5')
    })

    // The reason this helper exists at all. A provider base URL is admin-supplied config, so the
    // fetch the SDK uses must be filtered exactly like every other outbound call.
    it.each([
        ['private v4', 'http://10.0.0.1/'],
        ['link-local / metadata', 'http://169.254.169.254/latest/meta-data/'],
    ])('rejects %s rather than returning a Response', async (_label, url) => {
        await expect(safeHttp.fetch(url)).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup .* not allowed|IP .* not allowed|is not allowed/i),
        })
    })
})

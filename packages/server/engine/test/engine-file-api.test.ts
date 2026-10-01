import { createServer, Server } from 'node:http'
import { promisify } from 'node:util'
import { zstdCompress as zstdCompressCallback } from 'node:zlib'
import { FileType } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineFileApi } from '../src/lib/engine-file-api'
import { RetryPolicy } from '../src/lib/retrying-fetch'

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

// #595: the engine uploads the run log straight to the app, outside the worker's reconnect gate. An
// app restart longer than the old ~9 s retry budget lost the upload, and with it a run whose work was
// already done. These run the real 60 s default budget on fake time against a fetch that refuses
// the connection the way undici does while the app is gone.
describe('engineFileApi upload across an app outage', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('succeeds when the app comes back within the budget (down for 15 s, ENOTFOUND as in Docker)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        const fetchSpy = mockAppDownFor({ outageMs: 15_000, cause: enotfound() })

        const result = await settleOnFakeTime(engineFileApi.upload(UPLOAD))

        expect(result).toEqual({ status: 'fulfilled', value: { fileId: 'file-1', readUrl: 'http://x/y' } })
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    })

    it('still succeeds after a 50 s outage', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        mockAppDownFor({ outageMs: 50_000, cause: econnrefused() })

        const result = await settleOnFakeTime(engineFileApi.upload(UPLOAD))

        expect(result.status).toBe('fulfilled')
    })

    it('gives up once the outage outlasts the 60 s budget, with the original error', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        mockAppDownFor({ outageMs: Infinity, cause: econnrefused() })
        const startedAt = performance.now()

        const result = await settleOnFakeTime(engineFileApi.upload(UPLOAD))

        expect(result.status).toBe('rejected')
        expect(result.status === 'rejected' ? String(result.reason) : '').toContain('fetch failed')
        const elapsed = performance.now() - startedAt
        // It stops once too little budget is left for another attempt to get an answer.
        expect(elapsed).toBeGreaterThanOrEqual(59_900)
        expect(elapsed).toBeLessThanOrEqual(60_000)
    })

    it('retries a 502/503/504 from in front of the app', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        const statuses = [502, 503, 504]
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
            const status = statuses.shift()
            return status === undefined ? uploaded() : new Response('busy', { status })
        })

        const result = await settleOnFakeTime(engineFileApi.upload(UPLOAD))

        expect(result.status).toBe('fulfilled')
        expect(fetchSpy).toHaveBeenCalledTimes(4)
    })

    it.each([400, 401, 403, 404, 409, 413, 500])('fails fast on %i without retrying', async (status) => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('no', { status }))

        await expect(engineFileApi.upload(UPLOAD)).rejects.toThrow(`${status}`)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
})

// The same scenario on real sockets: undici's own errors for a closed port and a reset connection,
// with a small injected budget so nothing sleeps for a minute.
describe('engineFileApi against a real app that is down, then back', () => {
    const FAST: RetryPolicy = { budgetMs: 1_500, attemptTimeoutMs: 1_500, initialDelayMs: 20, maxDelayMs: 100 }
    let server: Server | undefined

    afterEach(async () => {
        vi.restoreAllMocks()
        if (server?.listening) {
            await new Promise<void>((resolve) => server?.close(() => resolve()))
        }
        server = undefined
    })

    it('uploads once the refused port starts accepting, and the app sees exactly one PUT', async () => {
        const port = await reservePort()
        const hits: string[] = []
        server = createServer((req, res) => {
            hits.push(`${req.method} ${req.url?.split('?')[0]}`)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ readUrl: 'http://x/y' }))
        })
        const listening = delay(400).then(() => listen({ server: server ?? createServer(), port }))

        const startedAt = Date.now()
        const result = await engineFileApi.upload({ ...UPLOAD, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: FAST })
        await listening

        expect(result.readUrl).toBe('http://x/y')
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(350)
        // The injected backoff, not a fixed multi-second delay, decides when the next attempt goes.
        expect(elapsed).toBeLessThan(2_500)
        expect(hits).toEqual(['PUT /v1/files/file-1'])
    })

    it('fails after the budget when the port never opens', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const port = await reservePort()

        const startedAt = Date.now()
        const error = await engineFileApi.upload({ ...UPLOAD, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: { ...FAST, budgetMs: 300 } }).catch((e: unknown) => e)

        expect(String(error)).toContain('fetch failed')
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(250)
        expect(elapsed).toBeLessThan(2_500)
    })

    it('replays the PUT after the app drops the connection mid-request', async () => {
        const port = await reservePort()
        let requests = 0
        server = createServer((req, res) => {
            requests += 1
            if (requests === 1) {
                req.socket.destroy()
                return
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ readUrl: 'http://x/y' }))
        })
        await listen({ server, port })

        const startedAt = Date.now()
        const result = await engineFileApi.upload({ ...UPLOAD, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: FAST })

        expect(result.readUrl).toBe('http://x/y')
        expect(requests).toBe(2)
        expect(Date.now() - startedAt).toBeLessThan(2_500)
    })

    it('retries the signed S3 PUT the app redirects to', async () => {
        const s3Statuses = [503, 502]
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
            if (String(input).startsWith('http://localhost:3000/')) {
                return new Response(null, { status: 307, headers: { 'location': 'https://s3.example/bucket/key?sig=1', 'x-ap-file-read-url': 'http://x/y' } })
            }
            const status = s3Statuses.shift()
            return new Response(status === undefined ? '' : 'busy', { status: status ?? 200 })
        })

        const result = await engineFileApi.upload({ ...UPLOAD, retryPolicy: FAST })

        expect(result.readUrl).toBe('http://x/y')
        expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).host)).toEqual(['localhost:3000', 's3.example', 's3.example', 's3.example'])
    })

    it('stops an attempt the app accepted but never answers once the attempt timeout is spent', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const port = await reservePort()
        let requests = 0
        server = createServer(() => {
            requests += 1
        })
        await listen({ server, port })

        const startedAt = Date.now()
        const error = await engineFileApi.upload({ ...UPLOAD, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: { ...FAST, attemptTimeoutMs: 400 } }).catch((e: unknown) => e)
        server.closeAllConnections()

        expect(error).toBeInstanceOf(DOMException)
        expect(error instanceof DOMException ? error.name : '').toBe('TimeoutError')
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(350)
        expect(elapsed).toBeLessThan(2_000)
        expect(requests).toBe(1)
    })

    it('uploads to a healthy app that answers only after the whole retry budget', async () => {
        const port = await reservePort()
        server = createServer((req, res) => {
            req.resume()
            req.on('end', () => setTimeout(() => {
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ readUrl: 'http://x/y' }))
            }, 600))
        })
        await listen({ server, port })

        const result = await engineFileApi.upload({ ...UPLOAD, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: { ...FAST, budgetMs: 100 } })

        expect(result.readUrl).toBe('http://x/y')
    })

    it('does not cut off a body that is still arriving when the attempt timeout ends', async () => {
        const port = await reservePort()
        server = createServer((_req, res) => {
            res.writeHead(200)
            res.write('first-')
            setTimeout(() => res.end('second'), 400)
        })
        await listen({ server, port })

        const bytes = await engineFileApi.download({ ...PARAMS, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: { ...FAST, attemptTimeoutMs: 100 } })

        expect(new TextDecoder().decode(bytes)).toBe('first-second')
    })

    it('downloads once the app is back', async () => {
        const port = await reservePort()
        server = createServer((_req, res) => res.end('payload'))
        const listening = delay(300).then(() => listen({ server: server ?? createServer(), port }))

        const startedAt = Date.now()
        const bytes = await engineFileApi.download({ ...PARAMS, apiUrl: `http://127.0.0.1:${port}/`, retryPolicy: FAST })
        await listening

        expect(new TextDecoder().decode(bytes)).toBe('payload')
        expect(Date.now() - startedAt).toBeLessThan(2_500)
    })
})

const UPLOAD = {
    ...PARAMS,
    type: FileType.FLOW_RUN_LOG,
    data: Buffer.from('log'),
} as const

function uploaded(): Response {
    return new Response(JSON.stringify({ readUrl: 'http://x/y' }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function econnrefused(): Error {
    return Object.assign(new Error('connect ECONNREFUSED 172.18.0.5:80'), { code: 'ECONNREFUSED' })
}

function enotfound(): Error {
    return Object.assign(new Error('getaddrinfo ENOTFOUND app'), { code: 'ENOTFOUND' })
}

function mockAppDownFor({ outageMs, cause }: { outageMs: number, cause: Error }) {
    const downUntil = performance.now() + outageMs
    return vi.spyOn(global, 'fetch').mockImplementation(async () => {
        if (performance.now() < downUntil) {
            throw new TypeError('fetch failed', { cause })
        }
        return uploaded()
    })
}

async function settleOnFakeTime<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
    const settled = Promise.allSettled([promise]).then(([result]) => result)
    let done = false
    void settled.then(() => {
        done = true
    })
    for (let elapsed = 0; !done && elapsed < 120_000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100)
    }
    return settled
}

async function reservePort(): Promise<number> {
    const probe = createServer()
    await listen({ server: probe, port: 0 })
    const address = probe.address()
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address')
    }
    return address.port
}

function listen({ server, port }: { server: Server, port: number }): Promise<void> {
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

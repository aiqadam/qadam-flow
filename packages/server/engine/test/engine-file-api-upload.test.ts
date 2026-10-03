import { createServer, IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { FileType } from '@aiqadam/shared'
import { pino } from 'pino'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EgressProxy, startEgressProxy } from '../../worker/src/lib/egress/proxy'
import { engineFileApi } from '../src/lib/engine-file-api'
import { ssrfGuard } from '../src/lib/network/ssrf-guard'
import { RetryPolicy } from '../src/lib/retrying-fetch'

const SILENT_LOG = pino({ level: 'silent' })
const FAST: RetryPolicy = { budgetMs: 0, attemptTimeoutMs: 5_000, initialDelayMs: 1, maxDelayMs: 1 }
const READ_URL = 'http://files.example/read/file-1'
const PAYLOAD = new TextEncoder().encode(JSON.stringify({ steps: { trigger: { output: { ok: true } } } }))

// The upload every run makes (run-log flush, large step outputs, qadam files), end to end over real
// sockets with the dispatcher the engine installs at startup. engine-file-api.test.ts mocks fetch,
// which is how #677 shipped: nothing there ever reached the npm undici dispatcher.
describe.each([
    { mode: 'UNRESTRICTED (plain Agent)', useEgressProxy: false },
    { mode: 'STRICT (ProxyAgent via the egress proxy)', useEgressProxy: true },
])('engineFileApi.upload — $mode', ({ useEgressProxy }) => {
    const originalDispatcher = getGlobalDispatcher()
    const originalEgressProxy = process.env['AP_EGRESS_PROXY_URL']
    let app: Server
    let s3: Server
    let appUrl: string
    let s3Url: string
    let proxy: EgressProxy | undefined
    let importTimeDispatcher: Agent | undefined
    let received: ReceivedRequest[] = []

    beforeAll(async () => {
        s3 = createServer((req, res) => record({ req, onEnd: () => res.end() }))
        await listen(s3)
        s3Url = `http://127.0.0.1:${portOf(s3)}/bucket/file-1?signature=abc`

        app = createServer((req, res) => record({
            req,
            onEnd: () => {
                if (req.url?.startsWith('/v1/files/redirected')) {
                    res.writeHead(307, { 'location': s3Url, 'x-ap-file-read-url': READ_URL })
                    res.end()
                    return
                }
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ readUrl: READ_URL }))
            },
        }))
        await listen(app)
        appUrl = `http://127.0.0.1:${portOf(app)}/`

        // In the engine bundle npm undici is imported before the first fetch, so its own Agent is
        // the global dispatcher before ssrfGuard.install() runs. Under vitest the built-in fetch
        // can win that race instead, and its older undici would hide the bug.
        importTimeDispatcher = new Agent()
        setGlobalDispatcher(importTimeDispatcher)

        if (useEgressProxy) {
            proxy = await startEgressProxy({ log: SILENT_LOG, allowList: ['127.0.0.1'] })
            process.env['AP_EGRESS_PROXY_URL'] = `http://127.0.0.1:${proxy.port}`
            ssrfGuard.install({ enabled: true, allowList: ['127.0.0.1'] })
        }
        else {
            ssrfGuard.install({ enabled: false })
        }
    })

    afterEach(() => {
        received = []
    })

    afterAll(async () => {
        ssrfGuard.uninstall()
        setGlobalDispatcher(originalDispatcher)
        if (originalEgressProxy === undefined) delete process.env['AP_EGRESS_PROXY_URL']
        else process.env['AP_EGRESS_PROXY_URL'] = originalEgressProxy
        await proxy?.close()
        await importTimeDispatcher?.close()
        await Promise.all([close(app), close(s3)])
    })

    it.each([
        { body: 'Uint8Array', data: PAYLOAD },
        { body: 'Buffer', data: Buffer.from(PAYLOAD) },
    ])('PUTs a $body to the app with one correct content-length', async ({ data }) => {
        const result = await engineFileApi.upload({ engineToken: 'token', apiUrl: appUrl, fileId: 'file-1', type: FileType.FLOW_RUN_LOG_SLICE, fileName: 'output.json', data, retryPolicy: FAST })

        expect(result).toEqual({ fileId: 'file-1', readUrl: READ_URL })
        expect(received).toEqual([{ path: '/v1/files/file-1', method: 'PUT', contentLength: String(PAYLOAD.length), transferEncoding: undefined, fileType: FileType.FLOW_RUN_LOG_SLICE, bodyLength: PAYLOAD.length }])
    })

    it.each([
        { body: 'Uint8Array', data: PAYLOAD },
        { body: 'Buffer', data: Buffer.from(PAYLOAD) },
    ])('replays a $body to the signed S3 URL with one correct content-length and no x-ap- headers', async ({ data }) => {
        const result = await engineFileApi.upload({ engineToken: 'token', apiUrl: appUrl, fileId: 'redirected', type: FileType.FLOW_RUN_LOG, data, retryPolicy: FAST })

        expect(result).toEqual({ fileId: 'redirected', readUrl: READ_URL })
        expect(received).toEqual([
            { path: '/v1/files/redirected', method: 'PUT', contentLength: String(PAYLOAD.length), transferEncoding: undefined, fileType: FileType.FLOW_RUN_LOG, bodyLength: PAYLOAD.length },
            { path: '/bucket/file-1', method: 'PUT', contentLength: String(PAYLOAD.length), transferEncoding: undefined, fileType: undefined, bodyLength: PAYLOAD.length },
        ])
    })

    function record({ req, onEnd }: RecordParams): void {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
            received = [...received, toReceived({ req, bodyLength: Buffer.concat(chunks).length })]
            onEnd()
        })
    }
})

function toReceived({ req, bodyLength }: ToReceivedParams): ReceivedRequest {
    return {
        path: req.url?.split('?')[0],
        method: req.method,
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
        fileType: headerValue(req.headers, 'x-ap-file-type'),
        bodyLength,
    }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name]
    return Array.isArray(value) ? value.join(', ') : value
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
}

function close(server: Server): Promise<void> {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(() => resolve()))
}

function portOf(server: Server): number {
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('server is not listening on a TCP port')
    }
    return address.port
}

type ReceivedRequest = {
    path: string | undefined
    method: string | undefined
    contentLength: string | undefined
    transferEncoding: string | undefined
    fileType: string | undefined
    bodyLength: number
}

type RecordParams = {
    req: IncomingMessage
    onEnd: () => void
}

type ToReceivedParams = {
    req: IncomingMessage
    bodyLength: number
}

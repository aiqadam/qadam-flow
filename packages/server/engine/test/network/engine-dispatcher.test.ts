import { createServer, IncomingHttpHeaders, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { pino } from 'pino'
import { Agent, getGlobalDispatcher, ProxyAgent, request, setGlobalDispatcher } from 'undici'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EgressProxy, startEgressProxy } from '../../../worker/src/lib/egress/proxy'
import { ssrfGuard } from '../../src/lib/network/ssrf-guard'

const SILENT_LOG = pino({ level: 'silent' })
const BODY = JSON.stringify({ hello: 'world' })
const BODY_LENGTH = Buffer.byteLength(BODY)

// No fetch mock anywhere: these go through Node's built-in fetch and the npm undici dispatcher the
// engine installs, which is the pair whose version mismatch broke every flow run (#677).
describe.each([
    { mode: 'UNRESTRICTED (plain Agent)', useEgressProxy: false },
    { mode: 'STRICT (ProxyAgent via the egress proxy)', useEgressProxy: true },
])('engine dispatcher — $mode', ({ useEgressProxy }) => {
    const originalDispatcher = getGlobalDispatcher()
    const originalEgressProxy = process.env['AP_EGRESS_PROXY_URL']
    let origin: Server
    let originUrl: string
    let proxy: EgressProxy | undefined
    let importTimeDispatcher: Agent | undefined
    let received: ReceivedRequest[] = []

    beforeAll(async () => {
        origin = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
                received = [...received, { method: req.method, headers: req.headers, bodyLength: Buffer.concat(chunks).length }]
                if (req.url === '/redirect') {
                    res.writeHead(307, { location: '/' })
                    res.end()
                    return
                }
                res.end('ok')
            })
        })
        await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
        originUrl = `http://127.0.0.1:${portOf(origin)}/`

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

    it('is the dispatcher behind the built-in fetch', () => {
        expect(getGlobalDispatcher()).not.toBe(importTimeDispatcher)
        expect(getGlobalDispatcher()).toBeInstanceOf(useEgressProxy ? ProxyAgent : Agent)
    })

    afterAll(async () => {
        ssrfGuard.uninstall()
        setGlobalDispatcher(originalDispatcher)
        if (originalEgressProxy === undefined) delete process.env['AP_EGRESS_PROXY_URL']
        else process.env['AP_EGRESS_PROXY_URL'] = originalEgressProxy
        await proxy?.close()
        await importTimeDispatcher?.close()
        origin.closeAllConnections()
        await new Promise<void>((resolve) => origin.close(() => resolve()))
    })

    it.each<FetchCase>([
        { name: 'string body + explicit content-length', init: { method: 'POST', body: BODY, headers: { 'content-length': String(BODY_LENGTH) } }, expectedLength: BODY_LENGTH },
        { name: 'string body + Content-Length (any casing)', init: { method: 'POST', body: BODY, headers: { 'Content-Length': String(BODY_LENGTH) } }, expectedLength: BODY_LENGTH },
        { name: 'empty PUT + content-length: 0', init: { method: 'PUT', headers: { 'content-length': '0' } }, expectedLength: 0 },
        { name: 'no body + content-length', init: { method: 'POST', headers: { 'content-length': '0' } }, expectedLength: 0 },
        { name: 'Buffer body + content-length', init: { method: 'PUT', body: Buffer.from(BODY), headers: { 'content-length': String(BODY_LENGTH) } }, expectedLength: BODY_LENGTH },
        { name: 'Uint8Array body + content-length', init: { method: 'PUT', body: new TextEncoder().encode(BODY), headers: { 'content-length': String(BODY_LENGTH) } }, expectedLength: BODY_LENGTH },
    ])('fetch: $name', async ({ init, expectedLength }) => {
        const response = await fetch(originUrl, init)

        expect(await response.text()).toBe('ok')
        expectSingleContentLength({ received, expectedLength })
    })

    it('fetch: numeric content-length', async () => {
        // RequestInit types header values as strings; JavaScript callers (and SDKs) pass a number,
        // which fetch stringifies. Reflect.apply keeps the call untyped instead of casting it.
        const response: Response = await Reflect.apply(fetch, globalThis, [originUrl, { method: 'POST', body: BODY, headers: { 'Content-Length': BODY_LENGTH } }])

        expect(await response.text()).toBe('ok')
        expectSingleContentLength({ received, expectedLength: BODY_LENGTH })
    })

    it('fetch: a followed 307 resends the body with one content-length', async () => {
        const response = await fetch(`${originUrl}redirect`, { method: 'PUT', body: Buffer.from(BODY), headers: { 'content-length': String(BODY_LENGTH) } })

        expect(await response.text()).toBe('ok')
        expect(received.map((r) => [r.headers['content-length'], r.bodyLength])).toEqual([[String(BODY_LENGTH), BODY_LENGTH], [String(BODY_LENGTH), BODY_LENGTH]])
    })

    it('fetch: stream body + content-length', async () => {
        // `duplex` is required for a stream body but missing from the DOM RequestInit type.
        const init: RequestInit & { duplex: 'half' } = {
            method: 'POST',
            body: new ReadableStream({
                start(controller): void {
                    controller.enqueue(Buffer.from(BODY))
                    controller.close()
                },
            }),
            headers: { 'content-length': String(BODY_LENGTH) },
            duplex: 'half',
        }
        const response = await fetch(originUrl, init)

        expect(await response.text()).toBe('ok')
        expectSingleContentLength({ received, expectedLength: BODY_LENGTH })
    })

    it('fetch: a content-length that disagrees with the body still fails', async () => {
        const error = await fetch(originUrl, { method: 'POST', body: BODY, headers: { 'content-length': '5' } }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(TypeError)
        expect(causeOf(error)).toMatchObject({ code: 'UND_ERR_INVALID_ARG', message: 'invalid content-length header' })
        expect(received).toEqual([])
    })

    it.each([
        { shape: 'plain object', headers: { 'Content-Length': '3, 3' } },
        { shape: 'flat array', headers: ['content-length', '3, 3'] },
        { shape: 'iterable of pairs', headers: new Map([['content-length', '3, 3']]) },
    ])('undici request: duplicated content-length as a $shape', async ({ headers }) => {
        const response = await request(originUrl, { method: 'POST', body: 'abc', headers })

        expect(await response.body.text()).toBe('ok')
        expectSingleContentLength({ received, expectedLength: 3 })
    })

    it.each([
        { shape: 'plain object', headers: { 'content-length': '3, 5' } },
        { shape: 'flat array', headers: ['Content-Length', '3, 5'] },
        { shape: 'iterable of pairs', headers: new Map([['content-length', '3, 5']]) },
    ])('undici request: mismatched content-length list as a $shape still fails', async ({ headers }) => {
        await expect(request(originUrl, { method: 'POST', body: 'abc', headers })).rejects.toMatchObject({
            code: 'UND_ERR_INVALID_ARG',
            message: 'invalid content-length header',
        })
        expect(received).toEqual([])
    })
})

function expectSingleContentLength({ received, expectedLength }: ExpectSingleContentLengthParams): void {
    expect(received).toHaveLength(1)
    expect(received[0].headers['content-length']).toBe(String(expectedLength))
    expect(received[0].headers['transfer-encoding']).toBeUndefined()
    expect(received[0].bodyLength).toBe(expectedLength)
}

function causeOf(error: unknown): unknown {
    return error instanceof Error ? error.cause : undefined
}

function portOf(server: Server): number {
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('server is not listening on a TCP port')
    }
    return address.port
}

type ReceivedRequest = {
    method: string | undefined
    headers: IncomingHttpHeaders
    bodyLength: number
}

type FetchCase = {
    name: string
    init: RequestInit
    expectedLength: number
}

type ExpectSingleContentLengthParams = {
    received: ReceivedRequest[]
    expectedLength: number
}

import { createServer, IncomingHttpHeaders, Server } from 'node:http'
import { AddressInfo, connect, Socket } from 'node:net'
import { pino } from 'pino'
import { Agent, Dispatcher, EnvHttpProxyAgent, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
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
    let importTimeDispatcher: RecordingAgent | undefined
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
        importTimeDispatcher = new RecordingAgent()
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
        importTimeDispatcher?.reset()
    })

    it(useEgressProxy ? 'routes the built-in fetch through the egress ProxyAgent' : 'routes the built-in fetch through the dispatcher that was already installed', async () => {
        await fetch(originUrl, { method: 'POST', body: BODY, headers: { 'content-length': String(BODY_LENGTH) } })

        if (useEgressProxy) {
            expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent)
        }
        else {
            expect(getGlobalDispatcher()).toBe(importTimeDispatcher)
        }
        expect(importTimeDispatcher?.dispatchCount).toBe(useEgressProxy ? 0 : 1)
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

    // Node 24.21's built-in fetch (undici 7.29) passes `5` alone, so the request stalls on the
    // body/length mismatch until something times it out. It must not succeed, and the origin must
    // never take the 17-byte body as one request.
    it('fetch: a content-length that disagrees with the body still fails', async () => {
        await expect(fetch(originUrl, { method: 'POST', body: BODY, headers: { 'content-length': '5' }, signal: AbortSignal.timeout(2_000) })).rejects.toThrow()

        expect(received.filter((r) => r.bodyLength === BODY_LENGTH)).toEqual([])
    })
})

// The case #679's review raised: Node installs an EnvHttpProxyAgent at startup when
// NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY are set, and UNRESTRICTED must keep routing through it.
describe('engine dispatcher — UNRESTRICTED keeps a pre-installed EnvHttpProxyAgent', () => {
    const originalDispatcher = getGlobalDispatcher()
    let origin: Server
    let originUrl: string
    let proxy: CountingConnectProxy
    let envProxyAgent: EnvHttpProxyAgent
    let received: ReceivedRequest[] = []

    beforeAll(async () => {
        origin = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
                received = [...received, { method: req.method, headers: req.headers, bodyLength: Buffer.concat(chunks).length }]
                res.end('ok')
            })
        })
        await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
        originUrl = `http://127.0.0.1:${portOf(origin)}/`
        proxy = await startCountingConnectProxy()
        // Explicit options: this container's own HTTPS_PROXY / NO_PROXY must not leak in.
        envProxyAgent = new EnvHttpProxyAgent({ httpProxy: proxy.url, httpsProxy: proxy.url, noProxy: '' })
        setGlobalDispatcher(envProxyAgent)
        ssrfGuard.install({ enabled: false })
    })

    afterAll(async () => {
        ssrfGuard.uninstall()
        expect(getGlobalDispatcher()).toBe(envProxyAgent)
        setGlobalDispatcher(originalDispatcher)
        await envProxyAgent.close()
        await proxy.close()
        origin.closeAllConnections()
        await new Promise<void>((resolve) => origin.close(() => resolve()))
    })

    it('still tunnels through the operator proxy, and the content-length reaches the origin once', async () => {
        const response = await fetch(originUrl, { method: 'PUT', body: Buffer.from(BODY), headers: { 'content-length': String(BODY_LENGTH) } })

        expect(await response.text()).toBe('ok')
        expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent)
        expect(proxy.connectCount()).toBeGreaterThan(0)
        expectSingleContentLength({ received, expectedLength: BODY_LENGTH })
    })
})

function expectSingleContentLength({ received, expectedLength }: ExpectSingleContentLengthParams): void {
    expect(received).toHaveLength(1)
    expect(received[0].headers['content-length']).toBe(String(expectedLength))
    expect(received[0].headers['transfer-encoding']).toBeUndefined()
    expect(received[0].bodyLength).toBe(expectedLength)
}

function portOf(server: Server): number {
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('server is not listening on a TCP port')
    }
    return address.port
}

async function startCountingConnectProxy(): Promise<CountingConnectProxy> {
    let connects = 0
    const sockets = new Set<Socket>()
    const server = createServer((_req, res) => {
        res.statusCode = 405
        res.end()
    })
    server.on('connect', (req, clientSocket: Socket, head: Buffer) => {
        connects += 1
        const [host, port] = (req.url ?? '').split(':')
        const upstream = connect(Number(port), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            upstream.write(head)
            upstream.pipe(clientSocket)
            clientSocket.pipe(upstream)
        })
        sockets.add(clientSocket).add(upstream)
        upstream.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
        url: `http://127.0.0.1:${portOf(server)}`,
        connectCount: () => connects,
        close: async (): Promise<void> => {
            sockets.forEach((socket) => socket.destroy())
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

class RecordingAgent extends Agent {
    dispatchCount = 0

    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        this.dispatchCount += 1
        return super.dispatch(options, handler)
    }

    reset(): void {
        this.dispatchCount = 0
    }
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

type CountingConnectProxy = {
    url: string
    connectCount: () => number
    close: () => Promise<void>
}

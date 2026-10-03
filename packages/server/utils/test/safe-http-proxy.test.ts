import { LookupAddress } from 'node:dns'
import dns from 'node:dns/promises'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { Duplex } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeHttp } from '../src/safe-http'

// Invariant under test: a request sent through an `HTTP(S)_PROXY` has its target checked by the
// same SSRF policy as a direct one, and nothing reaches the proxy for a target the policy refuses.
// The proxy fixture records every request line and CONNECT it receives, so "the proxy saw nothing"
// is asserted directly rather than inferred from an error message. `198.51.100.7` (TEST-NET-2) is
// outside the unicast range, so the filter refuses it unless a test allow-lists it — which is how
// these tests stand in for a public target without touching the network.

let proxy: RecordingProxy
let origin: RecordingOrigin
let savedEnv: Record<string, string | undefined>
let fakeLookupRecords: LookupAddress[] = []

beforeAll(async () => {
    proxy = await startRecordingProxy()
    origin = await startRecordingOrigin()
})

afterAll(async () => {
    await Promise.all([closeServer(proxy.server), closeServer(origin.server)])
})

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_UNDER_TEST.map((name) => [name, process.env[name]]))
    ENV_UNDER_TEST.forEach((name) => {
        Reflect.deleteProperty(process.env, name)
    })
    process.env['HTTP_PROXY'] = proxy.url
    process.env['HTTPS_PROXY'] = proxy.url
    proxy.seen.length = 0
    origin.seen.length = 0
})

afterEach(() => {
    vi.restoreAllMocks()
    ENV_UNDER_TEST.forEach((name) => {
        const value = savedEnv[name]
        if (value === undefined) {
            Reflect.deleteProperty(process.env, name)
        }
        else {
            process.env[name] = value
        }
    })
})

describe('safeHttp through an egress proxy', () => {
    it.each([
        ['http', 'http://10.0.0.1/'],
        ['https', 'https://10.0.0.1/'],
        ['http', 'http://169.254.169.254/latest/meta-data/'],
        ['https', 'https://169.254.169.254/latest/meta-data/'],
    ])('refuses a literal private or metadata %s target before contacting the proxy', async (_scheme, url) => {
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get(url)).rejects.toMatchObject({
            message: expect.stringMatching(/is not allowed.*AP_SSRF_ALLOW_LIST/),
        })
        expect(proxy.seen).toEqual([])
    })

    it.each([
        ['http', 'http://localhost:8080/'],
        ['https', 'https://localhost/'],
    ])('refuses a %s hostname that resolves to loopback before contacting the proxy', async (_scheme, url) => {
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get(url)).rejects.toMatchObject({
            message: expect.stringMatching(/is not allowed/),
        })
        expect(proxy.seen).toEqual([])
    })

    it('refuses a hostname when any one of its addresses is blocked, because the proxy may pick any', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        fakeLookupRecords = [
            { address: ALLOWED_TARGET, family: 4 },
            { address: '10.0.0.1', family: 4 },
        ]
        vi.spyOn(dns, 'lookup').mockImplementation(fakeLookup)
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get('http://mixed-records.example.test/')).rejects.toMatchObject({
            message: expect.stringMatching(/IP 10\.0\.0\.1 .*is not allowed/),
        })
        expect(proxy.seen).toEqual([])
    })

    it('fails closed when the target cannot be resolved locally', async () => {
        vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('getaddrinfo ENOTFOUND unresolvable.example.test'))
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get('http://unresolvable.example.test/')).rejects.toMatchObject({
            message: expect.stringMatching(/could not resolve unresolvable\.example\.test/),
        })
        expect(proxy.seen).toEqual([])
    })

    it('sends an allow-listed http target through the proxy', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        const response = await instance.get(`http://${ALLOWED_TARGET}/status?probe=1`)

        expect(response.data).toBe(PROXY_BODY)
        expect(proxy.seen).toEqual([`GET http://${ALLOWED_TARGET}/status?probe=1`])
    })

    it('tunnels an allow-listed https target with CONNECT to the checked host', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        // The fixture refuses every tunnel; reaching it with the right CONNECT line is the point.
        await expect(instance.get(`https://${ALLOWED_TARGET}/`)).rejects.toMatchObject({
            response: { status: 502 },
        })
        expect(proxy.seen).toEqual([`CONNECT ${ALLOWED_TARGET}:443`])
    })

    it('names the checked origin on the forward-proxy request line, whatever the Host header or path says', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await instance.get(`http://${ALLOWED_TARGET}//169.254.169.254/latest`, {
            headers: { Host: '169.254.169.254' },
        })

        expect(proxy.seen).toEqual([`GET http://${ALLOWED_TARGET}//169.254.169.254/latest`])
    })

    it('checks every redirect hop, not only the first request', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get(`http://${ALLOWED_TARGET}${REDIRECT_TO_METADATA_PATH}`)).rejects.toMatchObject({
            message: expect.stringMatching(/IP 169\.254\.169\.254 .*is not allowed/),
        })
        expect(proxy.seen).toEqual([`GET http://${ALLOWED_TARGET}${REDIRECT_TO_METADATA_PATH}`])
    })

    it('ignores proxy config on a request, so axios never proxies around the agents', async () => {
        Reflect.deleteProperty(process.env, 'HTTP_PROXY')
        process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get('http://10.0.0.1/', {
            proxy: { protocol: 'http', host: '127.0.0.1', port: proxy.port },
        })).rejects.toMatchObject({
            message: expect.stringMatching(/is not allowed/),
        })
        expect(proxy.seen).toEqual([])
    })

    it('routes a NO_PROXY match directly, where the filtering agent still checks it', async () => {
        process.env['NO_PROXY'] = '10.0.0.0/8,127.0.0.1'
        process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get('http://10.0.0.1/')).rejects.toMatchObject({
            message: expect.stringMatching(/is not allowed/),
        })
        const response = await instance.get(`${origin.url}/direct`)

        expect(response.data).toBe(ORIGIN_BODY)
        expect(origin.seen).toEqual(['GET /direct'])
        expect(proxy.seen).toEqual([])
    })

    it('refuses a proxy URL that is not http:// or https://', async () => {
        process.env['HTTP_PROXY'] = 'socks5://127.0.0.1:1080'
        process.env['AP_SSRF_ALLOW_LIST'] = ALLOWED_TARGET
        const instance = safeHttp.createAxios({ timeout: REQUEST_TIMEOUT_MS })

        await expect(instance.get(`http://${ALLOWED_TARGET}/`)).rejects.toMatchObject({
            message: expect.stringMatching(/must be an http:\/\/ or https:\/\/ URL/),
        })
    })

    // The AWS SDK's NodeHttpHandler takes these agents and never reads the proxy environment
    // itself, so they must keep connecting straight to the target, where the filter sees it.
    it('keeps buildDefaultAgents on the direct route even with a proxy configured', async () => {
        process.env['AP_SSRF_ALLOW_LIST'] = '127.0.0.1'
        const { httpAgent } = safeHttp.buildDefaultAgents()

        const status = await new Promise<number | undefined>((resolve, reject) => {
            http.get(`${origin.url}/sdk`, { agent: httpAgent }, (res) => {
                res.resume()
                resolve(res.statusCode)
            }).once('error', reject)
        })

        expect(status).toBe(200)
        expect(origin.seen).toEqual(['GET /sdk'])
        expect(proxy.seen).toEqual([])
    })
})

// Overloaded so it fits the `dns.lookup` overload set without a cast; the `{ all: true }` form is
// the only one the code under test calls.
function fakeLookup(hostname: string): Promise<LookupAddress>
async function fakeLookup(_hostname: string): Promise<LookupAddress | LookupAddress[]> {
    return fakeLookupRecords
}

async function startRecordingProxy(): Promise<RecordingProxy> {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`)
        if (req.url?.endsWith(REDIRECT_TO_METADATA_PATH) === true) {
            res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
            return
        }
        res.writeHead(200, { 'content-type': 'text/plain' }).end(PROXY_BODY)
    })
    server.on('connect', (req: http.IncomingMessage, socket: Duplex) => {
        seen.push(`CONNECT ${req.url}`)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    const port = await listen(server)
    return { server, seen, port, url: `http://127.0.0.1:${port}` }
}

async function startRecordingOrigin(): Promise<RecordingOrigin> {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`)
        res.writeHead(200, { 'content-type': 'text/plain' }).end(ORIGIN_BODY)
    })
    const port = await listen(server)
    return { server, seen, url: `http://127.0.0.1:${port}` }
}

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('fixture server did not bind a TCP port')
    }
    return address.port
}

async function closeServer(server: http.Server): Promise<void> {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

const ENV_UNDER_TEST = [
    'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY',
    'no_proxy', 'NO_PROXY', 'AP_SSRF_ALLOW_LIST',
]
const ALLOWED_TARGET = '198.51.100.7'
const REDIRECT_TO_METADATA_PATH = '/redirect-to-metadata'
const PROXY_BODY = 'via-proxy'
const ORIGIN_BODY = 'from-origin'
const REQUEST_TIMEOUT_MS = 3000

type RecordingProxy = {
    server: http.Server
    seen: string[]
    port: number
    url: string
}

type RecordingOrigin = {
    server: http.Server
    seen: string[]
    url: string
}

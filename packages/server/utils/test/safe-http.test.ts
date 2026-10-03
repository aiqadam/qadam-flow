import http from 'node:http'
import https from 'node:https'
import { httpTimeouts } from '@aiqadam/shared'
import { AxiosRequestConfig, AxiosResponse } from 'axios'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'
import { ProxyAwareFilteringAgent } from '../src/safe-http-proxy'

describe('safeHttp.buildAgents', () => {
    it('returns filtering agents by default', () => {
        const agents = safeHttp.buildAgents({ allowList: [] })
        expect(agents.httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
        expect(agents.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
    })

    it('subclasses the stdlib http/https Agent so axios accepts them', () => {
        const agents = safeHttp.buildAgents({ allowList: ['10.0.0.0/8'] })
        expect(agents.httpAgent).toBeInstanceOf(http.Agent)
        expect(agents.httpsAgent).toBeInstanceOf(https.Agent)
    })

    it('forwards the allow list to the underlying filter options', () => {
        const allowList = ['127.0.0.1', '10.0.0.0/8']
        const { httpAgent } = safeHttp.buildAgents({ allowList })
        expect(httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
    })
})

describe('safeHttp.createAxios', () => {
    // safeHttp's agents handle proxying themselves, so axios' own proxy handling stays off whatever
    // the caller says.
    it('keeps axios proxying off so the instance\'s own agents carry every request', () => {
        const instance = safeHttp.createAxios({ proxy: { host: '127.0.0.1', port: 3128 } })
        expect(instance.defaults.proxy).toBe(false)
        expect(instance.defaults.httpAgent).toBeInstanceOf(ProxyAwareFilteringAgent)
        expect(instance.defaults.httpsAgent).toBeInstanceOf(ProxyAwareFilteringAgent)
    })

    it('merges caller config (e.g. baseURL) with the filtering agents', () => {
        const instance = safeHttp.createAxios({ baseURL: 'https://example.com', httpsAgent: new https.Agent() })
        expect(instance.defaults.baseURL).toBe('https://example.com')
        expect(instance.defaults.httpsAgent).toBeInstanceOf(ProxyAwareFilteringAgent)
    })
})

describe('safeHttp end-to-end blocking', () => {
    it.each([
        ['loopback v4', 'http://127.0.0.1/'],
        ['loopback v6', 'http://[::1]/'],
        ['private v4', 'http://10.0.0.1/'],
        ['link-local / metadata', 'http://169.254.169.254/latest/meta-data/'],
    ])('rejects %s via safeHttp.axios', async (_label, url) => {
        const instance = safeHttp.createAxios({ timeout: 2000 })
        await expect(instance.get(url)).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup .* not allowed|IP .* not allowed|is not allowed/i),
        })
    })

    // A request's own config overrides the instance defaults, so anything that decides which code
    // opens the connection is pinned back per request; each override below could otherwise send
    // the request somewhere the filter never checks. The `socketPath` row sets `maxRedirects: 0`,
    // the native transport, where a socket path replaces the checked host.
    it.each<[string, AxiosRequestConfig, string]>([
        ['a custom adapter', { adapter: async (config): Promise<AxiosResponse> => ({ data: 'unfiltered', status: 200, statusText: 'OK', headers: {}, config }) }, 'http://10.0.0.1/'],
        ['a custom transport', { transport: { request: rejectingTransportRequest } }, 'http://10.0.0.1/'],
        ['its own httpAgent', { httpAgent: new http.Agent() }, 'http://10.0.0.1/'],
        ['its own httpsAgent', { httpsAgent: new https.Agent() }, 'https://10.0.0.1/'],
        ['the HTTP/2 transport', { httpVersion: 2 }, 'https://10.0.0.1/'],
        ['a socketPath', { socketPath: '/nonexistent/safe-http.sock', maxRedirects: 0 }, 'http://10.0.0.1/'],
    ])('keeps the filter on a request that asks for %s', async (_label, override, url) => {
        const instance = safeHttp.createAxios({ timeout: 2000 })
        await expect(instance.get(url, override)).rejects.toMatchObject({
            message: expect.stringMatching(/is not allowed/i),
        })
    })

    it('still blocks private IPs when caller relaxes TLS via httpsAgentOptions', async () => {
        const instance = safeHttp.createAxios(
            { timeout: 2000 },
            { httpsAgentOptions: { rejectUnauthorized: false } },
        )
        await expect(instance.get('https://127.0.0.1/')).rejects.toMatchObject({
            message: expect.stringMatching(/DNS lookup .* not allowed|IP .* not allowed|is not allowed/i),
        })
    })

    it('rewraps filter errors with the AP_SSRF_ALLOW_LIST remediation hint so operators know how to recover', async () => {
        const instance = safeHttp.createAxios({ timeout: 2000 })
        await expect(instance.get('http://10.0.0.1/')).rejects.toMatchObject({
            message: expect.stringContaining('AP_SSRF_ALLOW_LIST'),
        })
    })

    // GHSA-r3r9-wp5j-pq5g: through request-filtering-agent 3.2.0 a literal private-IP host made
    // `createConnection()` throw synchronously instead of failing the request, so `req.on('error')`
    // never saw it — and when Node's agent opens the socket for a pending request from its own
    // event handlers rather than inside `http.request()`, nothing catches it and the process dies.
    // These agents also go to clients that are not axios (the AWS SDK's NodeHttpHandler), which
    // only listen for the event. Pins the 3.2.1 shape.
    it.each([
        ['http', 'http://10.0.0.1/'],
        ['https', 'https://169.254.169.254/'],
    ])('reports a blocked literal IP on the %s request\'s error event instead of throwing', async (_label, url) => {
        const outcome = await requestThroughDefaultAgents({ url })
        expect(outcome).toMatchObject({
            thrownSynchronously: false,
            error: { message: expect.stringMatching(/is not allowed/i) },
        })
    })
})

// The value these resolve is no longer the server's alone — since #289 it is published on
// `/v1/flags` and the browser arms its own timers from it, so a bad one now breaks both sides at
// once.
describe('safeHttp provider timeout resolution', () => {
    const FIRST_BYTE = 'AP_HTTP_FIRST_BYTE_TIMEOUT_SECONDS'

    afterEach(() => {
        delete process.env[FIRST_BYTE]
    })

    it('falls back to the default when unset', () => {
        expect(safeHttp.firstByteTimeoutSeconds()).toBe(httpTimeouts.DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS)
        expect(safeHttp.streamIdleTimeoutSeconds()).toBe(httpTimeouts.DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS)
    })

    it.each(['0', '-1', 'forever', ''])('falls back rather than failing open on %o', (value) => {
        process.env[FIRST_BYTE] = value
        expect(safeHttp.firstByteTimeoutSeconds()).toBe(httpTimeouts.DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS)
    })

    it('honours a raised allowance', () => {
        process.env[FIRST_BYTE] = '900'
        expect(safeHttp.firstByteTimeoutSeconds()).toBe(900)
    })

    // `setTimeout` truncates its delay to a signed 32-bit integer, so an unclamped 3000000s becomes
    // a 1ms delay and every provider call fails instantly — the exact opposite of what an operator
    // writing "effectively unlimited" intended, and silent.
    it('clamps a value that would overflow setTimeout instead of arming a 1ms delay', () => {
        process.env[FIRST_BYTE] = '3000000'
        const seconds = safeHttp.firstByteTimeoutSeconds()

        expect(seconds).toBe(httpTimeouts.MAX_TIMEOUT_SECONDS)
        expect(seconds * 1000).toBeLessThan(2 ** 31)
    })
})

function rejectingTransportRequest(): never {
    throw new Error('custom transport used')
}

function requestThroughDefaultAgents({ url }: { url: string }): Promise<RequestOutcome> {
    const { httpAgent, httpsAgent } = safeHttp.buildDefaultAgents()
    return new Promise((resolve) => {
        try {
            const req = url.startsWith('https:')
                ? https.request(url, { agent: httpsAgent })
                : http.request(url, { agent: httpAgent })
            req.once('error', (error) => resolve({ thrownSynchronously: false, error }))
            req.once('response', () => resolve({ thrownSynchronously: false, error: undefined }))
            // A filter that lets the request through leaves it dialling an unroutable address; fail
            // with a message that says so rather than as an opaque vitest timeout.
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error(`${url} was not blocked: the request was still pending after ${REQUEST_TIMEOUT_MS}ms`))
            })
            req.end()
        }
        catch (error) {
            resolve({ thrownSynchronously: true, error })
        }
    })
}

const REQUEST_TIMEOUT_MS = 2000

type RequestOutcome = {
    thrownSynchronously: boolean
    error: unknown
}

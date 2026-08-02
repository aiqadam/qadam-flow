import http from 'node:http'
import https from 'node:https'
import { httpTimeouts } from '@aiqadam/shared'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { safeHttp } from '../src/safe-http'

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
    it('attaches filtering http and https agents to the axios instance', () => {
        const instance = safeHttp.createAxios()
        expect(instance.defaults.httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
        expect(instance.defaults.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
    })

    it('merges caller config (e.g. baseURL) with the filtering agents', () => {
        const instance = safeHttp.createAxios({ baseURL: 'https://example.com' })
        expect(instance.defaults.baseURL).toBe('https://example.com')
        expect(instance.defaults.httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
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

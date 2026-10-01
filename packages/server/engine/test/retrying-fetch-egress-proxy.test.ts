import { createServer, Server } from 'node:http'
import { pino } from 'pino'
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The worker's real egress proxy (proxy-chain), the one STRICT mode routes the engine through, so
// these pin the exact status and undici error the engine sees, not a hand-written imitation of them.
import { EgressProxy, startEgressProxy } from '../../worker/src/lib/egress/proxy'
import { retryingFetch, RetryPolicy } from '../src/lib/retrying-fetch'

const FAST: RetryPolicy = { budgetMs: 1_500, attemptTimeoutMs: 1_500, initialDelayMs: 20, maxDelayMs: 100 }
const SILENT_LOG = pino({ level: 'silent' })

// With AP_NETWORK_MODE=STRICT, `installEnvProxyDispatcher` makes an undici ProxyAgent the global
// dispatcher, and every engine call to the app becomes a CONNECT tunnel through this proxy (#595).
describe('retryingFetch behind the STRICT-mode egress proxy', () => {
    let proxy: EgressProxy
    let app: Server | undefined
    const originalDispatcher = getGlobalDispatcher()

    beforeEach(async () => {
        proxy = await startEgressProxy({ log: SILENT_LOG, allowList: ['127.0.0.1'] })
        setGlobalDispatcher(new ProxyAgent(`http://127.0.0.1:${proxy.port}`))
    })

    afterEach(async () => {
        setGlobalDispatcher(originalDispatcher)
        vi.restoreAllMocks()
        await proxy.close()
        if (app?.listening) {
            app.closeAllConnections()
            await new Promise<void>((resolve) => app?.close(() => resolve()))
        }
        app = undefined
    })

    it('retries while the proxy cannot resolve the app (container gone): the tunnel never opened', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = vi.spyOn(global, 'fetch')

        const error = await retryingFetch.fetch({ url: 'http://app-gone.invalid/v1/files/f1', init: { method: 'PUT', body: 'x' }, idempotent: false, policy: FAST }).catch((e: unknown) => e)

        expect(causeMessages(error)).toContain('Proxy response (500) !== 200 when HTTP Tunneling')
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    })

    it('fails at once when the proxy blocks the address (403): an SSRF block is never retried', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch')

        const error = await retryingFetch.fetch({ url: 'http://10.255.255.1/v1/files/f1', init: { method: 'PUT', body: 'x' }, idempotent: true, policy: FAST }).catch((e: unknown) => e)

        expect(causeMessages(error)).toContain('Proxy response (403) !== 200 when HTTP Tunneling')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    // A refused port behind the proxy never reaches the classifier: proxy-chain closes the tunnel
    // without answering, and undici's ProxyAgent reconnects on its own, in a tight loop, until the
    // app listens again or the attempt's deadline aborts it (#608).
    it('bounds that reconnect loop by the attempt timeout when the app never comes back (#608)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const port = await reservePort()

        const startedAt = Date.now()
        const error = await retryingFetch.fetch({ url: `http://127.0.0.1:${port}/v1/files/f1`, init: {}, idempotent: true, policy: { ...FAST, attemptTimeoutMs: 300 } }).catch((e: unknown) => e)

        expect(error instanceof DOMException ? error.name : error).toBe('TimeoutError')
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(250)
        expect(elapsed).toBeLessThan(2_000)
    })

    it('reaches the app once it is back', async () => {
        const port = await reservePort()
        app = createServer((_req, res) => res.end('ok'))
        const listening = new Promise((resolve) => setTimeout(resolve, 300)).then(() => listen({ server: app ?? createServer(), port }))

        const response = await retryingFetch.fetch({ url: `http://127.0.0.1:${port}/v1/files/f1`, init: {}, idempotent: true, policy: FAST })
        await listening

        expect(await response.text()).toBe('ok')
    })
})

function causeMessages(error: unknown): string[] {
    if (typeof error !== 'object' || error === null) {
        return []
    }
    const own = 'message' in error && typeof error.message === 'string' ? [error.message] : []
    return [...own, ...('cause' in error ? causeMessages(error.cause) : [])]
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

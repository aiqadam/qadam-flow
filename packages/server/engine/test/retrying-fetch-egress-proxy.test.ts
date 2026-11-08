import diagnosticsChannel from 'node:diagnostics_channel'
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

// With AP_NETWORK_MODE=STRICT, `installEngineDispatcher` makes an undici ProxyAgent the global
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

    // A refused port behind the proxy used to make proxy-chain close the tunnel without answering,
    // which undici's ProxyAgent reconnects from on its own, in a tight loop (~14k CONNECT/s) until
    // the app listens again (#608). The proxy now answers 502, so every CONNECT is one failed
    // attempt and `retryingFetch`'s backoff is what spaces them.
    it('opens one tunnel per attempt, not a reconnect storm, while the app refuses connections (#608)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const fetchSpy = vi.spyOn(global, 'fetch')
        const port = await reservePort()
        const tunnelAttempts = countTcpConnectsTo({ port: proxy.port })

        const error = await retryingFetch.fetch({ url: `http://127.0.0.1:${port}/v1/files/f1`, init: {}, idempotent: false, policy: { ...FAST, budgetMs: 600, attemptTimeoutMs: 1_000 } }).catch((e: unknown) => e)
        const connects = tunnelAttempts.stop()

        expect(connects).toBeLessThanOrEqual(fetchSpy.mock.calls.length)
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
        expect(causeMessages(error)).toContain('Proxy response (502) !== 200 when HTTP Tunneling')
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

// Every CONNECT is a new TCP connection to the proxy: the proxy closes the socket after a refusal,
// and `undici:client:beforeConnect` fires once per connection the proxy client opens.
function countTcpConnectsTo({ port }: { port: number }): { stop: () => number } {
    let count = 0
    const onConnect = (message: unknown): void => {
        if (isConnectMessage(message) && message.connectParams.port === String(port)) {
            count++
        }
    }
    diagnosticsChannel.subscribe('undici:client:beforeConnect', onConnect)
    return {
        stop: (): number => {
            diagnosticsChannel.unsubscribe('undici:client:beforeConnect', onConnect)
            return count
        },
    }
}

function isConnectMessage(message: unknown): message is { connectParams: { port: string } } {
    return typeof message === 'object' && message !== null && 'connectParams' in message
        && typeof message.connectParams === 'object' && message.connectParams !== null
        && 'port' in message.connectParams && typeof message.connectParams.port === 'string'
}

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

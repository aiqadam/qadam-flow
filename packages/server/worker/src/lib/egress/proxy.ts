import dns from 'node:dns/promises'
import { IncomingMessage } from 'node:http'
import net from 'node:net'
import { isNil, ssrfIpClassifier, tryCatch } from '@aiqadam/shared'
import { Logger } from 'pino'
import { Server as ProxyServer, RequestError } from 'proxy-chain'

export async function startEgressProxy({ log, allowList }: StartOptions): Promise<EgressProxy> {
    const server = new EgressProxyServer({
        port: 0,
        host: '127.0.0.1',
        // proxy-chain expects an empty upstream-override record when the request is allowed through unchanged.
        prepareRequestFunction: async ({ hostname }): Promise<Record<string, never>> => {
            await assertHostnameAllowedOrThrow({ hostname, allowList, log })
            return {}
        },
    })
    await server.listen()
    log.info({ port: server.port }, 'Egress proxy listening on loopback')
    return {
        port: server.port,
        close: () => server.close(true),
    }
}

// proxy-chain's own direct tunnel answers a CONNECT whose target refuses the connection by
// destroying the client socket without a word. undici reads a tunnel that closes before any
// response as a recoverable socket error and reconnects at once, so an engine call to an app whose
// name resolves but whose port is not listening yet spun at ~14k CONNECT/s until the app came back
// (#608). Answering 502 turns that into a failed attempt, which `retryingFetch` retries with backoff.
// The hostname check still runs first, through `prepareRequestHandling`, exactly as in the base class.
// A class only because overriding `onConnect` is proxy-chain's one extension point (packages/server/STYLE.md
// says no classes); the tunnel below is written against Node's net API, not taken from proxy-chain's source.
// It always connects directly: an `upstreamProxyUrl` or `customConnectServer` returned by
// `prepareRequestFunction` is not honoured here, and this proxy never returns either.
class EgressProxyServer extends ProxyServer {
    override async onConnect(request: IncomingMessage, sourceSocket: net.Socket, head: Buffer): Promise<void> {
        const { data: handlerOpts, error } = await tryCatch(() => this.prepareRequestHandling(request))
        if (error) {
            this.failRequest(request, this.normalizeHandlerError(error))
            return
        }
        const target = handlerOpts.trgParsed
        if (isNil(target)) {
            this.failRequest(request, new RequestError(`Target "${request.url}" could not be parsed`, 400))
            return
        }
        if (head.length > 0) {
            sourceSocket.unshift(head)
        }
        const targetSocket = net.createConnection({
            host: target.hostname.startsWith('[') ? target.hostname.slice(1, -1) : target.hostname,
            port: Number(target.port),
            localAddress: handlerOpts.localAddress,
            family: handlerOpts.ipFamily,
            lookup: handlerOpts.dnsLookup,
        })
        let established = false
        targetSocket.once('connect', () => {
            established = true
            sourceSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            sourceSocket.pipe(targetSocket)
            targetSocket.pipe(sourceSocket)
        })
        targetSocket.on('error', (cause) => {
            this.log(undefined, `Egress tunnel target ${request.url} failed: ${cause.message}`)
            if (!established) {
                this.sendSocketResponse(sourceSocket, 502, {}, `Egress target unreachable: ${target.hostname}`)
                return
            }
            sourceSocket.destroy()
        })
        // Once one side closes, the other must not linger: nothing would consume its data.
        targetSocket.once('close', () => sourceSocket.end())
        sourceSocket.once('close', () => targetSocket.destroy())
        sourceSocket.on('error', () => targetSocket.destroy())
    }
}

async function assertHostnameAllowedOrThrow({ hostname, allowList, log }: AssertHostnameAllowedParams): Promise<void> {
    // Resolve every A/AAAA record and reject if any is blocked. Checking only the first
    // resolved IP is bypassable with a multi-record response where one entry is private.
    // Residual risk: `EgressProxyServer.onConnect` re-resolves the hostname when it opens the
    // connection, so a timing-precise DNS rebind between the two lookups is not covered here.
    const ips = net.isIP(hostname) > 0
        ? [hostname]
        : (await dns.lookup(hostname, { all: true })).map((a) => a.address)
    const blocked = ips.find((ip) => ssrfIpClassifier.isBlockedIp({ ip, allowList }))
    if (blocked) {
        log.warn({ host: hostname, ip: blocked, allResolvedIps: ips }, 'Egress proxy refused request')
        throw new RequestError(`Egress blocked: ${hostname}`, 403)
    }
}

type StartOptions = {
    log: Logger
    allowList: string[]
}

type AssertHostnameAllowedParams = {
    hostname: string
    allowList: string[]
    log: Logger
}

export type EgressProxy = {
    port: number
    close: () => Promise<void>
}

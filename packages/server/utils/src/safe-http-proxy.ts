import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { ssrfIpClassifier } from '@aiqadam/shared'
import { Agent as AgentBase, AgentConnectOpts } from 'agent-base'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

// Invariant: a request that leaves through an `HTTP(S)_PROXY` is held to the same SSRF policy as a
// direct one. The filtering agents only ever see the socket they open, and through a proxy that
// socket goes to the proxy, not to the target — so whichever route the request takes, the target
// has to be checked here, explicitly, before anything is sent to the proxy.
//
// The axios instances therefore run with axios' own proxy handling switched off (`proxy: false`)
// and these agents take it over: they read the proxy environment per request, send a request that
// `NO_PROXY` exempts straight to the filtering agent, and resolve-and-check the target of every
// other one before handing it to a tunnelling agent. Keeping the agent chain explicit is the point:
// axios' built-in proxy support installs a tunnelling agent of its own in place of the configured
// `httpsAgent`, and the guarantee has to hold for whichever agent actually opens the connection.
export const safeHttpProxy = {
    buildProxyAwareAgents,
}

function buildProxyAwareAgents({ direct, allowList, httpsAgentOptions }: BuildProxyAwareAgentsParams): ProxyAwareAgents {
    return {
        httpAgent: new ProxyAwareFilteringAgent({ direct: direct.httpAgent, allowList, protocol: 'http:', agentOptions: {} }),
        // The TLS options ride on the outer agent so `http.Agent#addRequest` merges them into the
        // request options. The direct agent already carries its own copy; the tunnelling agent only
        // ever sees the request options, and applies them to the TLS session with the target. They
        // deliberately do not reach the TLS session with the proxy itself.
        httpsAgent: new ProxyAwareFilteringAgent({ direct: direct.httpsAgent, allowList, protocol: 'https:', agentOptions: httpsAgentOptions ?? {} }),
    }
}

class ProxyAwareFilteringAgent extends AgentBase {
    private readonly direct: http.Agent
    private readonly allowList: string[]
    private readonly tunnels = new Map<string, http.Agent>()

    constructor({ direct, allowList, protocol, agentOptions }: ProxyAwareFilteringAgentParams) {
        // `proxyEnv` would let Node proxy below this agent, around the check in `connect()`.
        super({ ...agentOptions, keepAlive: true, proxyEnv: undefined })
        this.direct = direct
        this.allowList = allowList
        this.protocol = protocol
    }

    // Positional parameters are agent-base's contract, not a choice made here.
    override async connect(_req: http.ClientRequest, opts: AgentConnectOpts): Promise<http.Agent> {
        const host = stripBrackets(opts.host ?? 'localhost')
        const proxyUrl = proxyUrlFor({ secure: opts.secureEndpoint, host, port: opts.port })
        if (proxyUrl === null) {
            return this.direct
        }
        // The proxy URL is operator configuration, trusted the way the database host is, so the hop
        // to the proxy is not filtered. Asking operators to put it on `AP_SSRF_ALLOW_LIST` would also
        // open the proxy's address (or its whole subnet, for a CIDR entry) to every user-supplied URL
        // that takes the direct route — and the check that matters is the one on the target below.
        await assertProxiedTargetAllowed({ host, allowList: this.allowList })
        return this.tunnelFor({ proxyUrl, secure: opts.secureEndpoint })
    }

    private tunnelFor({ proxyUrl, secure }: { proxyUrl: URL, secure: boolean }): http.Agent {
        const key = proxyUrl.href
        const cached = this.tunnels.get(key)
        if (cached !== undefined) {
            return cached
        }
        const tunnel = secure
            ? new HttpsProxyAgent(proxyUrl, { keepAlive: true })
            : new OriginPinnedHttpProxyAgent(proxyUrl, { keepAlive: true })
        this.tunnels.set(key, tunnel)
        return tunnel
    }
}

// A forward proxy dials whatever origin the absolute-form request line names. `HttpProxyAgent`
// builds that line from the `Host` header and resolves the request path against it, so a
// caller-supplied `Host` header, or a path that starts with `//`, would name an origin other than
// the one `connect()` just checked. The line is rebuilt here from the very host and port that were
// checked; the `Host` header still travels, but a proxy must ignore it for routing when the request
// line is absolute (RFC 9112 §3.2.2).
class OriginPinnedHttpProxyAgent extends HttpProxyAgent<string> {
    override setRequestProps(req: HttpProxyRequest, opts: AgentConnectOpts): void {
        const originPath = req.path
        if (!originPath.startsWith('/')) {
            throw new Error('safeHttp: a proxied request needs an origin-form path')
        }
        super.setRequestProps(req, opts)
        const host = formatHostForUrl(stripBrackets(opts.host ?? 'localhost'))
        const port = opts.port === 80 ? '' : `:${opts.port}`
        req.path = `http://${host}${port}${originPath}`
    }
}

// Resolves every A/AAAA record and requires all of them to pass: the proxy resolves the name again
// on its own and may pick any of them. That second lookup is a residual window this check cannot
// close — a name whose records change between the two lookups can still steer the proxy elsewhere —
// which is why the operator documentation asks for egress policy on the proxy as well. Pinning the
// target to the checked address instead (`CONNECT <ip>:443`) would close it, but would also defeat
// the hostname-based allow lists egress proxies are usually configured with.
async function assertProxiedTargetAllowed({ host, allowList }: { host: string, allowList: string[] }): Promise<void> {
    const addresses = net.isIP(host) !== 0 ? [host] : await resolveAll(host)
    if (addresses.length === 0) {
        throw new Error(`safeHttp: ${host} resolved to no address, so it cannot be checked before it is sent through the egress proxy`)
    }
    const blocked = addresses.find((ip) => ssrfIpClassifier.isBlockedIp({ ip, allowList }))
    if (blocked !== undefined) {
        throw new Error(`IP ${blocked} (host: ${host}) is not allowed as the target of a request through the egress proxy`)
    }
}

// Fails closed: a target the server cannot resolve is a target it cannot check, even when the proxy
// would have resolved it.
async function resolveAll(host: string): Promise<string[]> {
    try {
        const records = await dns.lookup(host, { all: true })
        return records.map((record) => record.address)
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`safeHttp: could not resolve ${host} to check it before sending it through the egress proxy: ${reason}`)
    }
}

// Mirrors the environment contract axios and `proxy-from-env` follow, so moving the decision here
// does not change which requests are proxied: `<scheme>_proxy`, then `all_proxy`, lower case before
// upper; a value without a scheme takes the request's own.
function proxyUrlFor({ secure, host, port }: ProxyTarget): URL | null {
    const scheme = secure ? 'https' : 'http'
    if (bypassesProxy({ host, port })) {
        return null
    }
    const raw = readEnv(`${scheme}_proxy`) || readEnv('all_proxy')
    if (raw === '') {
        return null
    }
    const proxyUrl = new URL(raw.includes('://') ? raw : `${scheme}://${raw}`)
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
        throw new Error(`safeHttp: the egress proxy must be an http:// or https:// URL, got ${proxyUrl.protocol}//`)
    }
    return proxyUrl
}

// The `NO_PROXY` grammar axios 1.20 accepts, CIDR entries included — those are common in container
// environments, and ignoring them would push internal traffic onto the proxy. Only where a request
// is routed depends on this; both routes are filtered.
function bypassesProxy({ host, port }: { host: string, port: number }): boolean {
    const noProxy = readEnv('no_proxy').toLowerCase()
    if (noProxy === '') {
        return false
    }
    const hostname = host.toLowerCase()
    return noProxy.split(/[\s,]+/).some((entry) => entry !== '' && noProxyEntryMatches({ entry, hostname, port }))
}

function noProxyEntryMatches({ entry, hostname, port }: { entry: string, hostname: string, port: number }): boolean {
    if (entry === '*') {
        return true
    }
    if (entry.includes('/')) {
        return isInCidr({ ip: hostname, cidr: entry })
    }
    const { entryHost, entryPort } = splitHostAndPort(entry)
    if (entryPort !== null && entryPort !== port) {
        return false
    }
    const pattern = entryHost.replace(/^\*/, '')
    if (pattern.startsWith('.')) {
        return hostname.endsWith(pattern)
    }
    return hostname === pattern
}

function splitHostAndPort(entry: string): { entryHost: string, entryPort: number | null } {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    if (bracketed !== null) {
        return { entryHost: bracketed[1], entryPort: bracketed[2] === undefined ? null : Number(bracketed[2]) }
    }
    const hostWithPort = /^([^:]+):(\d+)$/.exec(entry)
    if (hostWithPort !== null) {
        return { entryHost: hostWithPort[1], entryPort: Number(hostWithPort[2]) }
    }
    return { entryHost: entry, entryPort: null }
}

function isInCidr({ ip, cidr }: { ip: string, cidr: string }): boolean {
    const match = /^(.+)\/(\d{1,3})$/.exec(cidr)
    const family = net.isIP(ip)
    if (match === null || family === 0) {
        return false
    }
    const base = stripBrackets(match[1])
    if (net.isIP(base) !== family) {
        return false
    }
    const type = family === 4 ? 'ipv4' : 'ipv6'
    const blockList = new net.BlockList()
    try {
        blockList.addSubnet(base, Number(match[2]), type)
    }
    catch {
        return false
    }
    return blockList.check(ip, type)
}

function readEnv(name: string): string {
    return process.env[name.toLowerCase()] || process.env[name.toUpperCase()] || ''
}

function stripBrackets(host: string): string {
    return host.replace(/^\[(.*)\]$/, '$1')
}

function formatHostForUrl(host: string): string {
    return net.isIPv6(host) ? `[${host}]` : host
}

type HttpProxyRequest = Parameters<HttpProxyAgent<string>['setRequestProps']>[0]

type ProxyTarget = {
    secure: boolean
    host: string
    port: number
}

type ProxyAwareFilteringAgentParams = {
    direct: http.Agent
    allowList: string[]
    protocol: 'http:' | 'https:'
    agentOptions: http.AgentOptions
}

type BuildProxyAwareAgentsParams = {
    direct: { httpAgent: http.Agent, httpsAgent: https.Agent }
    allowList: string[]
    httpsAgentOptions?: https.AgentOptions
}

export type ProxyAwareAgents = {
    httpAgent: http.Agent
    httpsAgent: http.Agent
}

import { safeHttp } from '@aiqadam/server-utils'
import { AgentMcpTool, buildAuthHeaders, ValidateAgentMcpToolResponse } from '@aiqadam/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const mcpToolValidator = {
    async validateAgentMcpTool(tool: AgentMcpTool): Promise<ValidateAgentMcpToolResponse> {
        if (!isValidUrl(tool.serverUrl)) {
            return { toolNames: undefined, error: GENERIC_ERROR }
        }
        const headers = buildAuthHeaders(tool.auth)
        const transport = new StreamableHTTPClientTransport(new URL(tool.serverUrl), {
            requestInit: { headers },
            fetch: createSafeFetch(headers),
        })
        const client = new Client(MCP_CLIENT_INFO)
        try {
            await withTimeout(client.connect(transport), VALIDATE_TIMEOUT_MS)
            const result = await withTimeout(client.listTools(), VALIDATE_TIMEOUT_MS)
            return { toolNames: result.tools.map((t) => t.name), error: undefined }
        }
        catch {
            return { toolNames: undefined, error: GENERIC_ERROR }
        }
        finally {
            await transport.close().catch(() => undefined)
        }
    },
}

function createSafeFetch(extraHeaders: Record<string, string>): typeof fetch {
    return async (input, init) => {
        const url = input instanceof URL ? input.toString() : (typeof input === 'string' ? input : input.url)
        const origin = new URL(url)
        const response = await safeHttp.axios.request<ArrayBuffer>({
            method: init?.method ?? 'GET',
            url,
            // `Object.fromEntries(new Headers(...))`, not a spread: `init.headers` is a
            // `Headers` instance whose state lives in internal slots, so spreading it
            // yields `{}` and silently dropped the SDK's mandatory `accept` (#198).
            // Order matters and is deliberate — axios keeps the LAST value when two
            // keys differ only in case, and the SDK lowercases whatever it was given.
            // Today its copy of the auth header is a re-normalisation of the same
            // secret, so either order sends the same thing; if an `authProvider` is
            // ever passed to the transport above, the SDK would emit its own
            // `Authorization` and this order would let it win over the user's.
            headers: { ...extraHeaders, ...Object.fromEntries(new Headers(init?.headers)) },
            data: init?.body,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            timeout: VALIDATE_TIMEOUT_MS,
            maxContentLength: MAX_RESPONSE_BYTES,
            maxBodyLength: MAX_RESPONSE_BYTES,
            // Bounded, not disabled. The private-network case is already covered:
            // `follow-redirects` re-applies the filtering agent on every hop, not
            // only the first. What is left to stop is a redirect off the host the
            // user configured — it strips just Authorization, Proxy-Authorization
            // and Cookie, while API_KEY / HEADERS auth sends arbitrary header
            // names like `X-API-Key` that would travel to the new host verbatim.
            // Banning redirects outright would break a FastMCP-style mount that
            // 307s `/mcp` to `/mcp/`, which is the likeliest URL a user types by
            // hand, so same-host hops stay allowed and the cap stops a chain from
            // outliving the timeout — which is per-socket inactivity, re-armed on
            // every hop.
            maxRedirects: MAX_REDIRECTS,
            // Read from `href`, not from `hostname`/`protocol`: axios dispatches
            // its own proxy callback first, and that one overwrites those two
            // fields with the proxy's, so on any install with HTTP_PROXY set a
            // hostname comparison refuses every redirect including the same-host
            // one this exists to allow. `href` is the resolved redirect target and
            // the proxy rewrite leaves it alone. It also keeps IPv6 literals
            // comparable — `follow-redirects` strips the brackets off `hostname`
            // while `new URL()` keeps them.
            beforeRedirect: (options) => {
                const target = new URL(options.href)
                if (target.hostname !== origin.hostname) {
                    throw new Error('mcp validation refused a cross-host redirect')
                }
                if (origin.protocol === 'https:' && target.protocol !== 'https:') {
                    throw new Error('mcp validation refused an https-to-http redirect')
                }
            },
        })
        return new Response(Buffer.from(response.data), {
            status: response.status,
            headers: response.headers as Record<string, string>,
        })
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('mcp validation timeout')), ms)
    })
    try {
        return await Promise.race([promise, timeout])
    }
    finally {
        if (timer) clearTimeout(timer)
    }
}

function isValidUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'http:' || url.protocol === 'https:'
    }
    catch {
        return false
    }
}

const VALIDATE_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024
// Two covers the shapes that legitimately occur — a trailing-slash normalisation
// and an http-to-https upgrade, possibly both — without letting a chain of hops
// keep re-arming the per-socket inactivity timeout.
const MAX_REDIRECTS = 2
const MCP_CLIENT_INFO = { name: 'qadam-flow-validator', version: '1.0.0' }
const GENERIC_ERROR = 'Could not validate MCP server. Check the URL, authentication, and that the server is reachable.'

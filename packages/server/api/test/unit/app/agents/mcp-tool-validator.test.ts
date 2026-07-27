import { safeHttp } from '@aiqadam/server-utils'
import { AgentToolType, McpAuthType, McpProtocol } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpToolValidator } from '../../../../src/app/agents/mcp-tool-validator'

vi.mock('@aiqadam/server-utils', () => ({
    safeHttp: { axios: { request: vi.fn() } },
}))

type AxiosRequestConfigLike = {
    url?: string
    data?: string
    headers?: Record<string, string>
    maxRedirects?: number
    maxContentLength?: number
    maxBodyLength?: number
    timeout?: number
}
type AxiosCall = { url: string, body: Record<string, unknown>, config: AxiosRequestConfigLike }

const JSON_HEADERS = { 'content-type': 'application/json' }
const SSE_HEADERS = { 'content-type': 'text/event-stream' }

describe('mcpToolValidator.validateAgentMcpTool', () => {
    beforeEach(() => {
        vi.mocked(safeHttp.axios.request).mockReset()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns tool names from a tools/list JSON response', async () => {
        mockJsonRpcServer({ tools: [{ name: 'a' }, { name: 'b' }] })

        const result = await mcpToolValidator.validateAgentMcpTool(buildTool())

        expect(result.error).toBeUndefined()
        expect(result.toolNames).toEqual(['a', 'b'])
    })

    it('parses an SSE tools/list response', async () => {
        mockJsonRpcServer({ tools: [{ name: 'streamed' }] }, { forceSse: true })

        const result = await mcpToolValidator.validateAgentMcpTool(
            buildTool({ protocol: McpProtocol.STREAMABLE_HTTP }),
        )

        expect(result.error).toBeUndefined()
        expect(result.toolNames).toEqual(['streamed'])
    })

    it('sends initialize → notifications/initialized → tools/list in order', async () => {
        mockJsonRpcServer({ tools: [] })

        await mcpToolValidator.validateAgentMcpTool(buildTool())

        const methods = capturedCalls()
            .map((c) => c.body.method)
            .filter((method): method is string => typeof method === 'string')
        expect(methods).toEqual([
            'initialize',
            'notifications/initialized',
            'tools/list',
        ])
    })

    it('disables redirects and sets a 64KB response cap', async () => {
        mockJsonRpcServer({ tools: [] })

        await mcpToolValidator.validateAgentMcpTool(buildTool())

        const call = capturedCalls()[0]
        expect(call.config.maxRedirects).toBe(0)
        expect(call.config.maxContentLength).toBe(64 * 1024)
        expect(call.config.maxBodyLength).toBe(64 * 1024)
        expect(call.config.timeout).toBe(15_000)
    })

    it('collapses any downstream failure to a single generic error', async () => {
        vi.mocked(safeHttp.axios.request).mockRejectedValue(
            Object.assign(new Error('ENOTFOUND attacker.example'), { code: 'ENOTFOUND' }),
        )

        const result = await mcpToolValidator.validateAgentMcpTool(buildTool())

        expect(result.toolNames).toBeUndefined()
        expect(result.error).toBe(GENERIC_ERROR)
        expect(result.error).not.toMatch(/ENOTFOUND/i)
    })

    it('rejects malformed URLs without dialing', async () => {
        const spy = vi.mocked(safeHttp.axios.request)

        const result = await mcpToolValidator.validateAgentMcpTool(
            buildTool({ serverUrl: 'not a url' }),
        )

        expect(result.toolNames).toBeUndefined()
        expect(result.error).toBe(GENERIC_ERROR)
        expect(spy).not.toHaveBeenCalled()
    })

    it('rejects non-http(s) URLs without dialing', async () => {
        const spy = vi.mocked(safeHttp.axios.request)

        const result = await mcpToolValidator.validateAgentMcpTool(
            buildTool({ serverUrl: 'file:///etc/passwd' }),
        )

        expect(result.toolNames).toBeUndefined()
        expect(result.error).toBe(GENERIC_ERROR)
        expect(spy).not.toHaveBeenCalled()
    })

    describe('auth header mapping', () => {
        it('forwards API key header', async () => {
            mockJsonRpcServer({ tools: [] })

            await mcpToolValidator.validateAgentMcpTool(
                buildTool({
                    auth: {
                        type: McpAuthType.API_KEY,
                        apiKey: 'secret-123',
                        apiKeyHeader: 'X-API-Key',
                    },
                }),
            )

            const call = capturedCalls()[0]
            expect(call.config.headers?.['X-API-Key']).toBe('secret-123')
        })

        it('forwards Bearer access token', async () => {
            mockJsonRpcServer({ tools: [] })

            await mcpToolValidator.validateAgentMcpTool(
                buildTool({
                    auth: { type: McpAuthType.ACCESS_TOKEN, accessToken: 'tok-abc' },
                }),
            )

            const call = capturedCalls()[0]
            expect(call.config.headers?.['Authorization']).toBe('Bearer tok-abc')
        })
    })
})

const GENERIC_ERROR = 'Could not validate MCP server. Check the URL, authentication, and that the server is reachable.'

function defaultTool(): DefaultTool {
    return {
        type: AgentToolType.MCP,
        toolName: 'unit-test',
        serverUrl: 'https://mcp.example.com/rpc',
        protocol: McpProtocol.SIMPLE_HTTP,
        auth: { type: McpAuthType.NONE },
    }
}

type DefaultTool = {
    type: AgentToolType.MCP
    toolName: string
    serverUrl: string
    protocol: McpProtocol
    auth: { type: McpAuthType.NONE } | { type: McpAuthType.API_KEY, apiKey: string, apiKeyHeader: string } | { type: McpAuthType.ACCESS_TOKEN, accessToken: string } | { type: McpAuthType.HEADERS, headers: Record<string, string> }
}

function buildTool(overrides: Partial<DefaultTool> = {}): DefaultTool {
    return { ...defaultTool(), ...overrides }
}

function capturedCalls(): AxiosCall[] {
    return vi.mocked(safeHttp.axios.request).mock.calls.map(([config]) => {
        const requestConfig = config as AxiosRequestConfigLike
        return {
            url: String(requestConfig.url),
            body: typeof requestConfig.data === 'string' ? JSON.parse(requestConfig.data) : {},
            config: requestConfig,
        }
    })
}

function mockJsonRpcServer(
    { tools }: { tools: Array<{ name: string }> },
    { forceSse = false }: { forceSse?: boolean } = {},
): void {
    vi.mocked(safeHttp.axios.request).mockImplementation(async (...args: unknown[]) => {
        const config = args[0] as AxiosRequestConfigLike
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : {}
        if (body.method === 'initialize') {
            const payload = {
                jsonrpc: '2.0',
                id: body.id,
                result: {
                    protocolVersion: '2025-03-26',
                    serverInfo: { name: 'mock', version: '0' },
                    capabilities: { tools: {} },
                },
            }
            return makeAxiosResponse(payload, forceSse)
        }
        if (body.method === 'notifications/initialized') {
            return { status: 202, data: Buffer.alloc(0), headers: {} }
        }
        if (body.method === 'tools/list') {
            const payload = {
                jsonrpc: '2.0',
                id: body.id,
                result: { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object', properties: {} } })) },
            }
            return makeAxiosResponse(payload, forceSse)
        }
        return makeAxiosResponse({}, false)
    })
}

function makeAxiosResponse(payload: unknown, sse: boolean): { status: number, data: Buffer, headers: Record<string, string> } {
    if (sse) {
        return {
            status: 200,
            data: Buffer.from(`event: message\ndata: ${JSON.stringify(payload)}\n\n`),
            headers: SSE_HEADERS,
        }
    }
    return { status: 200, data: Buffer.from(JSON.stringify(payload)), headers: JSON_HEADERS }
}

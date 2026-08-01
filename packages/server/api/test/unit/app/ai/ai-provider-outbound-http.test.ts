import { AIProviderModelType, INVALID_AWS_REGION_MESSAGE, INVALID_AZURE_RESOURCE_NAME_MESSAGE } from '@aiqadam/shared'
import { ModelModality } from '@aws-sdk/client-bedrock'
import pino from 'pino'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anthropicProvider } from '../../../../src/app/ai/providers/anthropic-provider'
import { azureProvider } from '../../../../src/app/ai/providers/azure-provider'
import { bedrockProvider } from '../../../../src/app/ai/providers/bedrock-provider'
import { cloudflareGatewayProvider } from '../../../../src/app/ai/providers/cloudflare-gateway-provider'
import { googleProvider } from '../../../../src/app/ai/providers/google-provider'
import { mistralProvider } from '../../../../src/app/ai/providers/mistral-provider'
import { openaiProvider } from '../../../../src/app/ai/providers/openai-provider'
import { openRouterProvider } from '../../../../src/app/ai/providers/openrouter-provider'
import { providerHttp } from '../../../../src/app/ai/providers/provider-http'

// Every provider that makes a network call has to reach it through `safeHttp.axios`, the only
// axios instance in the process wearing request-filtering-agent. They used to import `httpClient`
// from `@aiqadam/qadams-common` — a bare `new AxiosHttpClient()`, no SSRF filtering at all, and
// invisible to the lint rule because the client arrived pre-built from another package (#276).
// Stubbing that one getter is therefore the assertion: a provider that slipped back to any other
// client would make no call through this mock, so the test goes red rather than quietly reaching
// the real network.
const { axiosRequest } = vi.hoisted(() => ({ axiosRequest: vi.fn() }))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        safeHttp: { ...actual.safeHttp, axios: { request: axiosRequest } },
    }
})

// Bedrock is the exception to the stub above: its SDK takes a `requestHandler`, not an axios
// instance or a `fetch` override, so what has to be asserted is the agents handed to that handler.
const { bedrockClientConfigs, bedrockSend, nodeHttpHandlerOptions } = vi.hoisted(() => ({
    bedrockClientConfigs: [] as Array<Record<string, unknown>>,
    bedrockSend: vi.fn(),
    nodeHttpHandlerOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@smithy/node-http-handler', () => ({
    NodeHttpHandler: vi.fn((options: Record<string, unknown>) => {
        nodeHttpHandlerOptions.push(options)
        return {}
    }),
}))

vi.mock('@aws-sdk/client-bedrock', () => ({
    BedrockClient: vi.fn((config: Record<string, unknown>) => {
        bedrockClientConfigs.push(config)
        return { send: bedrockSend }
    }),
    ListFoundationModelsCommand: vi.fn(() => ({ kind: 'foundation-models' })),
    ListInferenceProfilesCommand: vi.fn(() => ({ kind: 'inference-profiles' })),
    ModelModality: { TEXT: 'TEXT', IMAGE: 'IMAGE', EMBEDDING: 'EMBEDDING' },
}))

const AUTH = { apiKey: 'sk-secret-value' }
const BEDROCK_AUTH = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }
const VALID_AZURE_CONFIG = { resourceName: 'my-resource', apiVersion: undefined }
const silentLog = pino({ enabled: false })

function respondWith(data: unknown): void {
    axiosRequest.mockResolvedValue({ status: 200, statusText: 'OK', data, headers: {} })
}

function requestedUrls(): string[] {
    return axiosRequest.mock.calls.map(call => call[0].url)
}

function lastRequest(): { url: string, method: string, headers: Record<string, string> } {
    return axiosRequest.mock.calls[axiosRequest.mock.calls.length - 1][0]
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(() => null, (error: unknown) => error)
}

describe('AI provider outbound HTTP goes through safeHttp', () => {
    beforeEach(() => {
        axiosRequest.mockReset()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('openai lists models through the filtered client', async () => {
        respondWith({ data: [{ id: 'gpt-4.1' }, { id: 'dall-e-3' }] })

        const models = await openaiProvider.listModels(AUTH, {})

        expect(requestedUrls()).toEqual(['https://api.openai.com/v1/models'])
        expect(models).toEqual([
            { id: 'gpt-4.1', name: 'gpt-4.1', type: AIProviderModelType.TEXT },
            { id: 'dall-e-3', name: 'dall-e-3', type: AIProviderModelType.IMAGE },
        ])
    })

    it('anthropic lists models through the filtered client', async () => {
        respondWith({ data: [{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }] })

        const models = await anthropicProvider.listModels(AUTH, {})

        expect(requestedUrls()).toEqual(['https://api.anthropic.com/v1/models'])
        expect(models).toEqual([{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7', type: AIProviderModelType.TEXT }])
    })

    it('google lists models through the filtered client', async () => {
        respondWith({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] })

        const models = await googleProvider.listModels(AUTH, {})

        expect(requestedUrls()).toEqual(['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'])
        expect(models).toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', type: AIProviderModelType.TEXT }])
    })

    it('mistral lists models through the filtered client', async () => {
        respondWith({ data: [
            { id: 'mistral-large', capabilities: { completion_chat: true } },
            { id: 'mistral-embed', capabilities: { completion_chat: false } },
        ] })

        const models = await mistralProvider.listModels(AUTH, {})

        expect(requestedUrls()).toEqual(['https://api.mistral.ai/v1/models'])
        expect(models).toEqual([{ id: 'mistral-large', name: 'mistral-large', type: AIProviderModelType.TEXT }])
    })

    it('openrouter lists models and validates the key through the filtered client', async () => {
        respondWith({ data: [{ id: 'openai/gpt-4.1', name: 'GPT-4.1', architecture: { output_modalities: ['text'] } }] })

        const models = await openRouterProvider.listModels(AUTH, {})
        await openRouterProvider.validateConnection(AUTH, {}, silentLog)

        expect(requestedUrls()).toEqual([
            'https://openrouter.ai/api/v1/models',
            'https://openrouter.ai/api/v1/auth/key',
        ])
        expect(models).toEqual([{ id: 'openai/gpt-4.1', name: 'GPT-4.1', type: AIProviderModelType.TEXT }])
    })

    it('cloudflare gateway validates a compat model through the filtered client', async () => {
        respondWith({ choices: [] })

        await cloudflareGatewayProvider.validateConnection(
            AUTH,
            {
                accountId: 'acct',
                gatewayId: 'gw',
                models: [{ modelId: 'openai/gpt-4.1', modelName: 'GPT-4.1', modelType: AIProviderModelType.TEXT }],
            },
            silentLog,
        )

        expect(requestedUrls()).toEqual(['https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions'])
        expect(lastRequest().method).toBe('POST')
    })

    it('azure lists models through the filtered client for a valid resource name', async () => {
        respondWith({ data: [{ name: 'gpt-4o-deployment' }] })

        const models = await azureProvider.listModels(AUTH, VALID_AZURE_CONFIG)

        expect(axiosRequest).toHaveBeenCalledTimes(1)
        expect(new URL(lastRequest().url).host).toBe('my-resource.openai.azure.com')
        expect(models).toEqual([{ id: 'gpt-4o-deployment', name: 'gpt-4o-deployment', type: AIProviderModelType.TEXT }])
    })
})

// `listModels` is handed `aiProvider.config` straight off the row and never re-parses it, so the
// schema constraint on its own leaves a row written before that constraint able to keep
// re-pointing the host.
describe('azure refuses a stored resource name it would otherwise have to trust', () => {
    beforeEach(() => {
        axiosRequest.mockReset()
        respondWith({ data: [] })
    })

    it.each([
        ['attacker.example.com/'],
        ['attacker.example.com@resource'],
        ['my.resource'],
        [''],
    ])('sends no request at all for %j', async (resourceName) => {
        await expect(azureProvider.listModels(AUTH, { resourceName, apiVersion: undefined }))
            .rejects.toThrow(INVALID_AZURE_RESOURCE_NAME_MESSAGE)

        expect(axiosRequest).not.toHaveBeenCalled()
    })
})

// Bedrock is the one provider whose SDK takes neither an axios instance nor a `fetch` override,
// so it reaches the same request-filtering-agent through `requestHandler` instead — and `region`
// is the same host injection as Azure's `resourceName`: the SDK resolves `evil.com/` to host
// `bedrock.evil.com` and would sign the request on the way.
describe('bedrock', () => {
    beforeEach(() => {
        bedrockClientConfigs.length = 0
        nodeHttpHandlerOptions.length = 0
        bedrockSend.mockReset()
    })

    it.each([
        ['evil.com/'],
        ['x@evil.com'],
        ['us-east-1.evil.com'],
        [''],
    ])('builds no client at all for a stored region of %j', async (region) => {
        await expect(bedrockProvider.listModels(BEDROCK_AUTH, { region }))
            .rejects.toThrow(INVALID_AWS_REGION_MESSAGE)

        expect(bedrockClientConfigs).toHaveLength(0)
    })

    it('hands the SSRF-filtered agents to the SDK and still lists models', async () => {
        bedrockSend.mockImplementation(async (command: { kind: string }) => {
            if (command.kind === 'inference-profiles') {
                return { inferenceProfileSummaries: [] }
            }
            return {
                modelSummaries: [{
                    modelId: 'anthropic.claude-sonnet-4',
                    modelName: 'Claude Sonnet 4',
                    modelArn: 'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-4',
                    modelLifecycle: { status: 'ACTIVE' },
                    outputModalities: [ModelModality.TEXT],
                    responseStreamingSupported: true,
                }],
            }
        })

        const models = await bedrockProvider.listModels(BEDROCK_AUTH, { region: 'us-east-1' })

        expect(bedrockClientConfigs[0].region).toBe('us-east-1')
        // The one provider whose SDK takes neither an axios instance nor a `fetch` override, so it
        // reaches the same request-filtering-agent through `requestHandler`. Dropping that puts it
        // back on the SDK's own unfiltered handler, and this goes red.
        expect(nodeHttpHandlerOptions[0].httpsAgent).toBeInstanceOf(RequestFilteringHttpsAgent)
        expect(nodeHttpHandlerOptions[0].httpAgent).toBeInstanceOf(RequestFilteringHttpAgent)
        expect(models).toEqual([{ id: 'anthropic.claude-sonnet-4', name: 'Claude Sonnet 4', type: AIProviderModelType.TEXT }])
    })
})

// An AxiosError carries `config`, and `config` carries the outgoing headers — the provider api
// key. `aiProviderService.validateProviderCredentials` both logs the thrown error and puts its
// message on the wire as `httpErrorResponse`, so nothing axios threw may escape `providerHttp`.
describe('providerHttp does not let axios leak the api key out of a failure', () => {
    beforeEach(() => {
        axiosRequest.mockReset()
    })

    it('drops everything axios attached to a transport error', async () => {
        const axiosError = Object.assign(new Error('getaddrinfo ENOTFOUND provider.example.com'), {
            isAxiosError: true,
            config: {
                headers: { 'api-key': 'super-secret-key', 'Authorization': 'Bearer super-secret-key' },
                data: 'the whole prompt',
            },
        })
        axiosRequest.mockRejectedValue(axiosError)

        const thrown = await rejection(azureProvider.listModels(AUTH, VALID_AZURE_CONFIG))

        expect(thrown).toBeInstanceOf(Error)
        expect(thrown).not.toBe(axiosError)
        const surface = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))
        expect(surface).not.toContain('super-secret-key')
        expect(surface).toContain('getaddrinfo ENOTFOUND provider.example.com')
        expect(Object.getOwnPropertyNames(thrown)).not.toContain('config')
        expect(Object.getOwnPropertyNames(thrown)).not.toContain('cause')
    })

    it('keeps the SSRF remediation hint the interceptor appends', async () => {
        axiosRequest.mockRejectedValue(new Error('DNS lookup 127.0.0.1 is not allowed — add its IP or CIDR to the AP_SSRF_ALLOW_LIST environment variable'))

        await expect(azureProvider.listModels(AUTH, VALID_AZURE_CONFIG)).rejects.toThrow(/AP_SSRF_ALLOW_LIST/)
    })

    it('reports a non-2xx as a bounded message instead of a thrown AxiosError', async () => {
        axiosRequest.mockResolvedValue({
            status: 401,
            statusText: 'Unauthorized',
            data: { error: { message: 'Access denied due to invalid subscription key' } },
            headers: {},
        })

        await expect(providerHttp.sendJson({ url: 'https://example.com', method: 'GET', headers: { 'api-key': 'super-secret-key' } }))
            .rejects.toThrow('Request failed with status 401: {"error":{"message":"Access denied due to invalid subscription key"}}')
    })

    it('truncates an oversized error body', async () => {
        axiosRequest.mockResolvedValue({ status: 500, statusText: 'Server Error', data: 'x'.repeat(5000), headers: {} })

        const thrown = await rejection(providerHttp.sendJson({ url: 'https://example.com', method: 'GET', headers: {} }))

        expect(thrown).toBeInstanceOf(Error)
        expect(thrown instanceof Error ? thrown.message.length : 0).toBeLessThan(600)
    })
})

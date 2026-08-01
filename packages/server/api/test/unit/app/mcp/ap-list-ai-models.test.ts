import { AIProviderModelType, AIProviderName, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const listProviders = vi.fn()
const listModels = vi.fn()

type MockedAiProviderService = { listProviders: typeof listProviders, listModels: typeof listModels }
type MockedToolError = { content: { type: string, text: string }[], isError: boolean }

vi.mock('../../../../src/app/ai/ai-provider-service', () => ({
    aiProviderService: (): MockedAiProviderService => ({ listProviders, listModels }),
}))

vi.mock('../../../../src/app/mcp/tools/mcp-utils', () => ({
    mcpUtils: {
        resolvePlatformId: async (): Promise<string> => 'platform-id',
        mcpToolError: (message: string): MockedToolError => ({ content: [{ type: 'text', text: message }], isError: true }),
    },
}))

import { apListAiModelsTool } from '../../../../src/app/mcp/tools/ap-list-ai-models'

const log = { error: () => {}, info: () => {}, warn: () => {} } as unknown as FastifyBaseLogger

const mcp: ProjectScopedMcpServer = {
    id: 'mcp-id',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    platformId: 'platform-id',
    projectId: 'project-id',
    type: McpServerType.PROJECT,
    token: 'token',
    disabledTools: null,
}

async function runTool(): Promise<string> {
    listProviders.mockResolvedValue([
        { id: 'row-first-custom', provider: AIProviderName.CUSTOM, name: 'LM Studio' },
        { id: 'row-second-custom', provider: AIProviderName.CUSTOM, name: 'Ollama' },
    ])
    listModels.mockResolvedValue([{ id: 'llama-3', name: 'Llama 3', type: AIProviderModelType.TEXT }])

    const result = await apListAiModelsTool(mcp, log).execute({})
    return result.content[0].text
}

// #274 pulled `providerId` back out of this usage line because nothing read it, and an agent that
// sent it would have pinned a step to one custom provider while the run executed against the
// platform's oldest. The AI qadam reads it now, so the advertisement has to come back — and it has
// to keep naming `provider` too, since capability gating is keyed on the enum and cannot take an id.
describe('ap_list_ai_models usage line', () => {
    it('tells the caller to send the row id alongside the provider name', async () => {
        const text = await runTool()

        expect(text).toContain('"providerId": "<provider row id>"')
        expect(text).toContain('"provider": "<provider>"')
    })

    it('says what omitting the id resolves to, so the fallback is not a surprise', async () => {
        const text = await runTool()

        expect(text).toContain('oldest row of that type')
    })

    it('lists each row id so two providers of the same type can be told apart', async () => {
        const text = await runTool()

        expect(text).toContain('row-first-custom')
        expect(text).toContain('row-second-custom')
    })
})

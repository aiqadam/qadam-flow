import { McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetByKeyOrNull = vi.fn()
const mockUsages = vi.fn()
const mockDelete = vi.fn()

vi.mock('../../../../src/app/translation/translation.service', () => ({
    translationService: vi.fn(() => ({
        getByKeyOrNull: mockGetByKeyOrNull,
        usages: mockUsages,
        delete: mockDelete,
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: vi.fn().mockResolvedValue({ id: 'project-1', platformId: 'platform-1' }),
    })),
}))

import { apDeleteTranslationTool } from '../../../../src/app/mcp/tools/ap-delete-translation'

const log: FastifyBaseLogger = {
    level: 'info',
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: () => log,
}
const mcp: ProjectScopedMcpServer = {
    id: 'mcp-1',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    type: McpServerType.PROJECT,
    projectId: 'project-1',
    platformId: 'platform-1',
    token: 'token',
    disabledTools: null,
}

describe('ap_delete_translation — usages in the response', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetByKeyOrNull.mockResolvedValue({ id: 'translation-1', key: 'greeting' })
        mockDelete.mockResolvedValue({ id: 'translation-1', key: 'greeting' })
    })

    it('lists the flows still referencing the key, read before the row is deleted', async () => {
        mockUsages.mockResolvedValue({
            key: 'greeting',
            usages: [{ flowId: 'flow-1', flowDisplayName: 'Welcome Flow', referencedInDraft: true, referencedInPublished: false }],
            scannedFlowCount: 1,
            truncated: false,
        })

        const result = await apDeleteTranslationTool(mcp, log).execute({ key: 'greeting' })

        // `usages` must be called with the target BEFORE `delete` removes the row it looks flows
        // up by — asserting call order, not just that both were called.
        expect(mockUsages).toHaveBeenCalledWith({ id: 'translation-1', projectId: 'project-1', platformId: 'platform-1' })
        expect(mockUsages.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0])

        expect(result.content[0].text).toContain('Welcome Flow')
        expect((result.structuredContent as { usages: unknown[] }).usages).toHaveLength(1)
    })

    it('says no flow referenced it when usages is empty', async () => {
        mockUsages.mockResolvedValue({ key: 'greeting', usages: [], scannedFlowCount: 0, truncated: false })

        const result = await apDeleteTranslationTool(mcp, log).execute({ key: 'greeting' })

        expect(result.content[0].text).toContain('No flow referenced it')
        expect((result.structuredContent as { usages: unknown[] }).usages).toEqual([])
    })
})

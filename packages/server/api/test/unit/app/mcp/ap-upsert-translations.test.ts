import { McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/app/translation/translation.service', () => ({
    translationService: vi.fn(() => ({
        upsertBatch: vi.fn(),
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: vi.fn().mockResolvedValue({ id: 'project-1', platformId: 'platform-1' }),
    })),
}))

import { apUpsertTranslationsTool } from '../../../../src/app/mcp/tools/ap-upsert-translations'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

describe('ap_upsert_translations — empty translations array (Low)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    // `.min(1, ...)`'s message is a raw string, not a zod-schema error CODE — it must be the
    // formErrors.required constant's VALUE ("required"), not the literal string
    // "formErrors.required" (an i18n key that does not exist, only its own name echoed back).
    it('reports the shared formErrors.required message, not the literal string "formErrors.required"', async () => {
        const result = await apUpsertTranslationsTool(mcp, log).execute({ translations: [] })

        expect(result.content[0].text).toContain('required')
        expect(result.content[0].text).not.toContain('formErrors.required')
    })
})

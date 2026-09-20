import { McpServerType, ProjectScopedMcpServer, VariableWithoutSensitiveData } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetOneOrThrow, mockList } = vi.hoisted(() => ({
    mockGetOneOrThrow: vi.fn(),
    mockList: vi.fn(),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: mockGetOneOrThrow,
    })),
}))

vi.mock('../../../../src/app/variable/variable.service', () => ({
    variableService: vi.fn(() => ({
        list: mockList,
    })),
}))

import { apListVariablesTool } from '../../../../src/app/mcp/tools/ap-list-variables'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: null } as unknown as ProjectScopedMcpServer

// #485 review finding 3: `VARIABLE_NAME_REGEX` (`/^[a-zA-Z0-9_]+$/`) constrains `variable.name` on
// its only write path — like `step.name`, there is nothing here for `wrapUntrustedValue` to guard
// against, and the same name must be copied verbatim into the `{{variables['...']}}` reference on
// the same line, so wrapping it would be noise on a value that needs reuse.
describe('ap_list_variables — a schema-constrained variable name stays bare (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneOrThrow.mockResolvedValue({ id: 'project-1', platformId: 'platform-1' })
    })

    it('does not wrap variable.name, unlike the free-text values elsewhere in this file', async () => {
        const variable = { id: 'var-1', name: 'API_TOKEN', created: '2024-01-01T00:00:00.000Z', updated: '2024-01-01T00:00:00.000Z' } as VariableWithoutSensitiveData
        mockList.mockResolvedValue({ data: [variable] })

        const result = await apListVariablesTool(mcp, log).execute({})
        const rendered = (result.content?.[0] as { text: string }).text

        expect(rendered).toBe('- API_TOKEN (id: var-1) — reference: {{variables[\'API_TOKEN\']}}, created: 2024-01-01T00:00:00.000Z, updated: 2024-01-01T00:00:00.000Z')
        expect(rendered).not.toContain('⟦')
    })
})

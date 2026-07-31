import { McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { qadamFlowTools } from '../../../../src/app/mcp/tools'

// `resolvePermissionChecker` allows a tool that declares no `permission` to anyone with project
// access. That is only safe while the undeclared set stays exactly this: metadata and discovery,
// nothing that reads or writes project data. A new tool added without a permission would otherwise
// be allowed by default for every role — the quiet version of the bug this whole check exists to
// close. Adding a name here is a deliberate act, which is the point.
const TOOLS_WITHOUT_A_PERMISSION = [
    'ap_get_piece_props',
    'ap_list_ai_models',
    'ap_research_pieces',
    'ap_resolve_property_chain',
    'ap_resolve_property_options',
    'ap_setup_guide',
    'ap_validate_step_config',
]

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

describe('registered MCP tool permissions', () => {
    it('declares a permission on every tool except the known metadata ones', () => {
        const undeclared = qadamFlowTools(mcp, 'user-id', log)
            .filter((tool) => tool.permission === undefined)
            .map((tool) => tool.title)
            .sort()

        expect(undeclared).toEqual(TOOLS_WITHOUT_A_PERMISSION)
    })
})

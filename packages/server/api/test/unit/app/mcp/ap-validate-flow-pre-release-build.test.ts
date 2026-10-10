import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: mockGetPlatformId,
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: mockGet,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer
const SNAPSHOT_VERSION = '1.3.0-main.412'
const RELEASE_VERSION = '1.3.0'

function flowWithPieceStep({ qadamVersion }: { qadamVersion: string }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Pre-release Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Send Email',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: '@aiqadam/qadam-test-email',
                        qadamVersion,
                        actionName: 'send_email',
                        input: {},
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

async function validate({ qadamVersion }: { qadamVersion: string }): Promise<{ text: string, structuredContent: Record<string, unknown> }> {
    mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion }))
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return {
        text: (result.content?.[0] as { text: string }).text,
        structuredContent: result.structuredContent as Record<string, unknown>,
    }
}

// ADR-0004: a snapshot pin (`x.y.z-main.<n>`) runs a build from `main`. It is a fact, not a fault,
// so it is informational — reported, never blocking, and never counted as a warning or an issue.
describe('ap_validate_flow — pre-release build note (ADR-0004, #855)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: SNAPSHOT_VERSION })
    })

    it('reports a snapshot pin as an informational note, not an issue or a warning', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: SNAPSHOT_VERSION })

        expect(text).toContain('Notes (informational):')
        expect(text).toContain('Pre-Release Builds:')
        expect(text).toContain('pre-release build from main')

        const informational = structuredContent.informational as { category: string, stepName: string, message: string }[]
        expect(informational).toEqual([expect.objectContaining({ category: 'pre_release_build', stepName: 'step_1' })])
        expect((structuredContent.issues as { category: string }[]).map(i => i.category)).not.toContain('pre_release_build')
        expect((structuredContent.warnings as { category: string }[]).map(i => i.category)).not.toContain('pre_release_build')
    })

    it('reports a caret-prefixed snapshot pin the same way', async () => {
        const { structuredContent } = await validate({ qadamVersion: `~${SNAPSHOT_VERSION}` })

        expect((structuredContent.informational as { category: string }[]).map(i => i.category)).toContain('pre_release_build')
    })

    it('does not change whether the flow is valid — the note is never a defect', async () => {
        const snapshot = await validate({ qadamVersion: SNAPSHOT_VERSION })
        const release = await validate({ qadamVersion: RELEASE_VERSION })

        expect(snapshot.structuredContent.valid).toBe(release.structuredContent.valid)
    })

    it('says nothing about a release pin', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: RELEASE_VERSION })

        expect(text).not.toContain('Pre-Release Builds:')
        expect(text).not.toContain('Notes (informational):')
        expect(structuredContent.informational).toEqual([])
    })
})
